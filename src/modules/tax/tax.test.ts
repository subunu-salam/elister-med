import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { ctxFor } from "@/test/helpers";
import { ensureChartOfAccounts } from "@/modules/ledger/accounts";
import { postJournal } from "@/modules/ledger/journal";
import { trialBalance } from "@/modules/reports/trialBalance";
import { fromDecimal128 } from "@/core/money";
import { setTaxConfig, computeCorporateTax, addTaxAdjustment, provisionCorporateTax, payCorporateTax, markReturnFiled, CT } from "./corporateTax";
import { registerAsset, runDepreciation, disposeAsset, assetRegisterSummary } from "@/modules/assets/service";
import { recordExpense } from "@/modules/finance/expenses";

const ORG = "org-tax";
const fin = ctxFor(["finance_manager"], ORG, "fin1", "b1");
const acct = ctxFor(["accountant"], ORG, "acc1", "b1");
const id = (c: string) => `${ORG}:${c}`;
let k = 0;
const d = (ymd: string) => new Date(`${ymd}T10:00:00+04:00`);

async function bookYear(year: number, revenue: string, expense: string) {
  await postJournal(fin, { date: d(`${year}-06-15`), memo: `Revenue ${year}`, sourceRef: { type: "t", id: `r${year}` }, idempotencyKey: `rev-${year}-${k++}`, lines: [{ accountId: id("1010"), debit: revenue }, { accountId: id("4000"), credit: revenue }] });
  if (Number(expense) > 0) await postJournal(fin, { date: d(`${year}-07-15`), memo: `Costs ${year}`, sourceRef: { type: "t", id: `e${year}` }, idempotencyKey: `exp-${year}-${k++}`, lines: [{ accountId: id("5000"), debit: expense }, { accountId: id("1010"), credit: expense }] });
}

beforeAll(async () => {
  await ensureIndexes();
  await ensureChartOfAccounts(ORG);
  for (const year of [2025, 2026, 2027, 2028]) for (let m = 1; m <= 12; m++)
    await tenantCol<any>(ORG, "fiscal_periods").insertOne({ _id: `${ORG}:${year}-${m}`, year, month: m, status: "open", start: new Date(Date.UTC(year, m - 1, 1, -4)), end: new Date(Date.UTC(year, m, 1, -4)) });
  await setTaxConfig(fin, { registered: true, sbrElected: false, firstYear: 2025, trn: "100123456700003" });
});
afterAll(async () => { await closeClient(); });

describe("corporate tax computation", () => {
  it("2025: a loss creates a tax loss and no tax", async () => {
    await bookYear(2025, "400000.00", "700000.00");
    const c = await computeCorporateTax(fin, 2025);
    expect(c.accountingProfit.toFixed(2)).toBe("-300000.00");
    expect(c.tax.toFixed(2)).toBe("0.00");
    expect(c.lossCarriedForward.toFixed(2)).toBe("300000.00");
  });
  it("2026: 9% only above AED 375,000, loss relief capped at 75%", async () => {
    await bookYear(2026, "1200000.00", "400000.00");           // profit 800,000
    const c = await computeCorporateTax(fin, 2026);
    expect(c.taxableBeforeLoss.toFixed(2)).toBe("800000.00");
    expect(c.lossUsed.toFixed(2)).toBe("300000.00");            // min(300,000 pool, 75% x 800,000 = 600,000)
    expect(c.taxableIncome.toFixed(2)).toBe("500000.00");
    expect(c.tax.toFixed(2)).toBe(((500000 - CT.zeroBand) * 0.09).toFixed(2)); // 11,250.00
    expect(c.lossCarriedForward.toFixed(2)).toBe("0.00");
  });
  it("add-backs from tagged expenses and manual adjustments change taxable income", async () => {
    const e = await recordExpense(acct, { category: "5700", vendor: "Gala Events LLC", description: "Client dinner", net: "10000.00", vatRate: "STD", paidFrom: "bank", treatment: "entertainment_50", idempotencyKey: "ent-1", date: d("2026-09-01") });
    expect(fromDecimal128(e.irrecoverableVat).toFixed(2)).toBe("500.00");   // VAT on entertainment is not recoverable
    await addTaxAdjustment(acct, { year: 2026, kind: "add_back", label: "Traffic and municipality fines", amount: "1000.00" });
    const c = await computeCorporateTax(fin, 2026);
    // profit fell by 10,500 (expense incl. VAT) -> 789,500; add back 50% x 10,500 = 5,250 and fines 1,000
    expect(c.accountingProfit.toFixed(2)).toBe("789500.00");
    expect(c.taxableBeforeLoss.toFixed(2)).toBe((789500 + 5250 + 1000).toFixed(2) + "");
  });
  it("Small Business Relief when elected and revenue is within AED 3m: no tax, no loss carry-forward", async () => {
    await setTaxConfig(fin, { registered: true, sbrElected: true, firstYear: 2025 });
    const c = await computeCorporateTax(fin, 2026);
    expect(c.sbrApplied).toBe(true);
    expect(c.tax.toFixed(2)).toBe("0.00");
    await setTaxConfig(fin, { registered: true, sbrElected: false, firstYear: 2025, trn: "100123456700003" });
  });
});

describe("provision, payment and filing", () => {
  it("books the provision once, adjusts by difference, pays, and locks on filing", async () => {
    const c = await computeCorporateTax(fin, 2026);
    const r1 = await provisionCorporateTax(fin, 2026);
    expect(r1.booked.toFixed(2)).toBe(c.tax.toFixed(2));
    const r2 = await provisionCorporateTax(fin, 2026);                 // nothing changed -> no new entry
    expect(r2.delta.toFixed(2)).toBe("0.00");
    await addTaxAdjustment(acct, { year: 2026, kind: "deduct", label: "Qualifying exempt income", amount: "20000.00" });
    const r3 = await provisionCorporateTax(fin, 2026);
    expect(r3.delta.isNegative()).toBe(true);
    const tb = await trialBalance(fin, {});
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
    const payable = (await computeCorporateTax(fin, 2026)).payable;
    await expect(payCorporateTax(fin, { year: 2026, amount: payable.plus(1).toFixed(2), idempotencyKey: "p-over" })).rejects.toThrow(/exceeds/);
    await payCorporateTax(fin, { year: 2026, amount: payable.toFixed(2), idempotencyKey: "p1" });
    await payCorporateTax(fin, { year: 2026, amount: "0.01", idempotencyKey: "p1" }).catch(() => undefined); // same key is a no-op
    expect((await computeCorporateTax(fin, 2026)).payable.toFixed(2)).toBe("0.00");
    await markReturnFiled(fin, { year: 2026, reference: "FTA-CT-2026-0001" });
    await expect(addTaxAdjustment(acct, { year: 2026, kind: "add_back", label: "Late change", amount: "5.00" })).rejects.toThrow(/already filed/);
  });
  it("only roles with ledger permissions can touch tax", async () => {
    const rec = ctxFor(["receptionist"], ORG, "r1", "b1");
    await expect(computeCorporateTax(rec, 2026)).rejects.toThrow();
    await expect(provisionCorporateTax(rec, 2026)).rejects.toThrow();
  });
});

describe("fixed-asset register", () => {
  it("registers, depreciates monthly, ties to the ledger, and disposes with gain or loss", async () => {
    await postJournal(fin, { date: d("2027-01-02"), memo: "Capital", sourceRef: { type: "t", id: "cap" }, idempotencyKey: "cap-1", lines: [{ accountId: id("1010"), debit: "100000.00" }, { accountId: id("3000"), credit: "100000.00" }] });
    const a = await registerAsset(acct, { name: "Dental chair unit", category: "Dental equipment", cost: "60000.00", vat: "3000.00", residual: "0.00", lifeMonths: 60, purchaseDate: d("2027-01-05"), paidFrom: "bank" });
    await registerAsset(acct, { name: "Autoclave", category: "Medical equipment", cost: "12000.00", lifeMonths: 36, purchaseDate: d("2027-01-10"), paidFrom: "bank" });
    const r = await runDepreciation(acct, "2027-01");
    expect(r.posted).toBe("1333.33");                                  // 60,000/60 = 1,000 + 12,000/36 = 333.33
    expect((await runDepreciation(acct, "2027-01")).posted).toBe("0.00"); // second run does nothing
    await runDepreciation(acct, "2027-02");
    const s = await assetRegisterSummary(acct);
    expect(s.reconciled).toBe(true);
    expect(s.accumulated.toFixed(2)).toBe("2666.66");
    const sold = await disposeAsset(fin, { id: a._id, proceeds: "50000.00" });
    expect(fromDecimal128(sold.disposal!.gainLoss).toFixed(2)).toBe("-8000.00"); // NBV 58,000 sold for 50,000
    expect((await assetRegisterSummary(acct)).reconciled).toBe(true);
    const tb = await trialBalance(fin, {});
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
  });
});
