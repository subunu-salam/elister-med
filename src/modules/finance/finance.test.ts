import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { money, toDecimal128, fromDecimal128 } from "@/core/money";
import { ctxFor } from "@/test/helpers";
import { ensureChartOfAccounts } from "@/modules/ledger/accounts";
import { postJournal } from "@/modules/ledger/journal";
import { trialBalance } from "@/modules/reports/trialBalance";
import { createPatient } from "@/modules/patients/service";
import { finalizeInvoice } from "@/modules/billing/invoice";
import { recordPayment } from "@/modules/billing/payment";
import { submitJournalForApproval, decideDraftJournal, closePeriod, closeFiscalYear } from "@/modules/ledger/drafts";
import {
  openRegister, closeRegister, transferFunds, pettyCashExpense, importBankStatement, autoMatchBank, bankReconciliation, settleCardBatch, gatewayUnsettled,
} from "./cashbank";
import { balanceSheet, cashFlow, vatSummary, setBudget, budgetVsActual, branchProfitability, pharmacyMargin } from "./statements";

const ORG = "org-fin";
const Y = new Date().getUTCFullYear();
const cash1 = ctxFor(["receptionist"], ORG, "cash1", "br1");
const cash2 = ctxFor(["receptionist"], ORG, "cash2", "br1");
const acc = ctxFor(["accountant"], ORG, "acc1", "br1");
const fin = ctxFor(["finance_manager"], ORG, "fin1", "br1");
const fin2 = ctxFor(["finance_manager"], ORG, "fin2", "br1");
const acct = (c: string) => `${ORG}:${c}`;
let n = 0;

async function periods(org: string, years = [Y - 1, Y, Y + 1]) {
  for (const year of years) for (let m = 1; m <= 12; m++)
    await tenantCol<any>(org, "fiscal_periods").insertOne({ _id: `${org}:${year}-${m}`, year, month: m, status: "open", start: new Date(Date.UTC(year, m - 1, 1, -4)), end: new Date(Date.UTC(year, m, 1, -4)) });
}
async function bal(code: string, org = ORG, c = fin) {
  const tb = await trialBalance({ ...c, orgId: org }, {});
  return tb.rows.find((r) => r.code === code)?.balance ?? money(0);
}
async function invoice(ctx: typeof cash1, price: string, rate: string) {
  const p = (await createPatient(ctx, { fullName: `Fin Patient ${n++}`, dob: "1980-01-01", sex: "male", phone: `+97150${String(8000000 + n)}` }))._id;
  const id = `fc-${Math.random().toString(36).slice(2)}`;
  await tenantCol<any>(ctx.orgId, "charges").insertOne({ _id: id, patientId: p, encounterId: "e", serviceId: "s", serviceCode: "X", name: "X", kind: "consultation", qty: 1, unitPrice: toDecimal128(money(price)), taxCode: "STD", taxRate: toDecimal128(money(rate)), revenueAccountSystem: "rev_consultation", doctorId: "d1", status: "unbilled", createdAt: new Date(), createdBy: "x" });
  return finalizeInvoice(ctx, { patientId: p, chargeIds: [id] });
}

beforeAll(async () => {
  await ensureIndexes();
  await ensureChartOfAccounts(ORG);
  await periods(ORG);
  await tenantCol<any>(ORG, "tax_codes").insertOne({ _id: `${ORG}:t`, code: "STD", rate: toDecimal128(money("5")), kind: "standard", reviewRequired: true });
  await tenantCol<any>(ORG, "branches").insertOne({ _id: "br1", code: "B1", name: "Branch One", emirate: "Dubai", active: true });
});
afterAll(async () => { await closeClient(); });

describe("cash drawer, petty cash, transfers", () => {
  it("drawer reconciles to cash taken; a variance needs a note and posts to Cash Over and Short", async () => {
    const i1 = await invoice(cash1, "100.00", "0");
    await openRegister(cash1, { openingFloat: "200.00" });
    await expect(openRegister(cash1, { openingFloat: "1" })).rejects.toMatchObject({ code: "CONFLICT" });
    await recordPayment(cash1, { invoiceId: i1._id, method: "cash", amount: "100.00", idempotencyKey: "cash1-p1" });
    const closed = await closeRegister(cash1, { counted: "300.00" });
    expect(fromDecimal128(closed.variance).toFixed(2)).toBe("0.00");

    const i2 = await invoice(cash2, "50.00", "0");
    await openRegister(cash2, { openingFloat: "100.00" });
    await recordPayment(cash2, { invoiceId: i2._id, method: "cash", amount: "50.00", idempotencyKey: "cash2-p1" });
    await expect(closeRegister(cash2, { counted: "140.00" })).rejects.toMatchObject({ code: "VALIDATION" });
    const v0 = await bal("5330");
    const c2 = await closeRegister(cash2, { counted: "140.00", note: "Change given in error" });
    expect(fromDecimal128(c2.variance).toFixed(2)).toBe("-10.00");
    expect((await bal("5330")).minus(v0).toFixed(2)).toBe("10.00");
    await expect(closeRegister(cash2, { counted: "1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("petty cash expense hits an expense account only; transfers are idempotent and balanced", async () => {
    await postJournal(acc, { date: new Date(), memo: "fund petty cash", idempotencyKey: "pc-fund", sourceRef: { type: "t", id: "1" }, lines: [{ accountId: acct("1015"), debit: "100" }, { accountId: acct("1000"), credit: "100" }] });
    const p0 = await bal("1015");
    await pettyCashExpense(acc, { expenseCode: "5800", amount: "12.50", description: "Printer paper", idempotencyKey: "pc-1" });
    await pettyCashExpense(acc, { expenseCode: "5800", amount: "12.50", description: "Printer paper", idempotencyKey: "pc-1" });
    expect(p0.minus(await bal("1015")).toFixed(2)).toBe("12.50");
    await expect(pettyCashExpense(acc, { expenseCode: "1000", amount: "1", description: "bad target", idempotencyKey: "pc-2" })).rejects.toMatchObject({ code: "VALIDATION" });
    const b0 = await bal("1010");
    await transferFunds(acc, { from: "cash", to: "bank", amount: "100.00", idempotencyKey: "dep-1" });
    await transferFunds(acc, { from: "cash", to: "bank", amount: "100.00", idempotencyKey: "dep-1" });
    expect((await bal("1010")).minus(b0).toFixed(2)).toBe("100.00");
    await expect(transferFunds(acc, { from: "bank", to: "bank", amount: "1", idempotencyKey: "x" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("bank statement import and reconciliation", () => {
  const today = new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
  it("imports once, auto-matches by amount and date, and explains every difference", async () => {
    const lines = [{ date: today, description: "Cash deposit", amount: "100.00", reference: "DEP1" }, { date: today, description: "Bank fee", amount: "-25.00", reference: "FEE1" }];
    const a = await importBankStatement(acc, { account: "bank", lines });
    const b = await importBankStatement(acc, { account: "bank", lines });
    expect(a.added).toBe(2);
    expect(b.skipped).toBe(2);
    expect((await autoMatchBank(acc, "bank")).matched).toBe(1);
    const r = await bankReconciliation(fin, { account: "bank", statementEndBalance: "75.00" });
    expect(r.unmatchedStatement).toHaveLength(1);
    expect(r.notBooked.toFixed(2)).toBe("-25.00");
    expect(r.reconciled).toBe(true);
    const wrong = await bankReconciliation(fin, { account: "bank", statementEndBalance: "80.00" });
    expect(wrong.reconciled).toBe(false);
    expect(wrong.unexplainedDifference.toFixed(2)).toBe("5.00");
  });
});

describe("card settlement", () => {
  it("card payments sit in clearing until the acquirer settles net of fees; settlement is idempotent", async () => {
    const inv = await invoice(cash1, "50.00", "0");
    const u0 = await gatewayUnsettled(fin);
    await recordPayment(cash1, { invoiceId: inv._id, method: "card", amount: "50.00", idempotencyKey: "card-1" });
    expect((await gatewayUnsettled(fin)).minus(u0).toFixed(2)).toBe("50.00");
    const bank0 = await bal("1010"), fee0 = await bal("5810");
    await settleCardBatch(fin, { reference: "SETTLE-1", gross: "50.00", fees: "1.50" });
    await settleCardBatch(fin, { reference: "SETTLE-1", gross: "50.00", fees: "1.50" });
    expect((await bal("1010")).minus(bank0).toFixed(2)).toBe("48.50");
    expect((await bal("5810")).minus(fee0).toFixed(2)).toBe("1.50");
    expect((await gatewayUnsettled(fin)).toFixed(2)).toBe(u0.toFixed(2));
  });
});

describe("financial statements", () => {
  it("balance sheet balances (assets = liabilities + equity + current earnings)", async () => {
    await postJournal(acc, { date: new Date(), memo: "owner capital", idempotencyKey: "cap-1", sourceRef: { type: "t", id: "cap" }, lines: [{ accountId: acct("1010"), debit: "1000.00" }, { accountId: acct("3000"), credit: "1000.00" }] });
    const bs = await balanceSheet(fin);
    expect(bs.balanced).toBe(true);
    expect(bs.totalAssets.toFixed(2)).toBe(bs.totalLiabilitiesAndEquity.toFixed(2));
    expect(bs.equity.find((e) => e.code === "3000")!.amount.toFixed(2)).toBe("1000.00");
    await expect(balanceSheet(ctxFor(["receptionist"], ORG))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("cash flow classifies capital as financing and reconciles opening + movement to closing", async () => {
    const cf = await cashFlow(fin, { from: new Date(`${Y}-01-01T00:00:00+04:00`), to: new Date(Date.now() + 86400000) });
    expect(cf.financing.toFixed(2)).toBe("1000.00");
    expect(cf.operating.gt(0)).toBe(true);
    expect(cf.reconciles).toBe(true);
  });

  it("VAT summary agrees with the ledger and classifies supplies", async () => {
    await invoice(cash1, "100.00", "5");
    const v = await vatSummary(fin, { from: new Date(`${Y}-01-01T00:00:00+04:00`), to: new Date(Date.now() + 86400000) });
    expect(v.outputVat.gte(5)).toBe(true);
    expect(v.suppliesByClass.standard.gte(100)).toBe(true);
    expect((await bal("2100")).negated().toFixed(2)).toBe(v.outputVat.toFixed(2));
    expect(v.note).toMatch(/tax professional/);
  });

  it("budget vs actual is pro-rated; only authorised roles set budgets", async () => {
    await expect(setBudget(cash1, { year: Y, accountCode: "4000", amount: "1000" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setBudget(fin, { year: Y, accountCode: "1000", amount: "1000" })).rejects.toMatchObject({ code: "VALIDATION" });
    await setBudget(fin, { year: Y, accountCode: "4000", amount: "36500.00" });
    const r = await budgetVsActual(fin, { from: new Date(`${Y}-01-01T00:00:00+04:00`), to: new Date(`${Y}-01-11T00:00:00+04:00`) });
    const row = r.rows.find((x) => x.code === "4000")!;
    expect(row.budget.gt(0)).toBe(true);
  });

  it("branch profitability sums to consolidated (plus unassigned); pharmacy margin from ledger", async () => {
    await postJournal(acc, { date: new Date(), memo: "pharmacy sale", idempotencyKey: "ph-s", sourceRef: { type: "t", id: "ph" }, lines: [{ accountId: acct("1000"), debit: "100" }, { accountId: acct("4300"), credit: "100" }] });
    await postJournal(acc, { date: new Date(), memo: "pharmacy cogs", idempotencyKey: "ph-c", sourceRef: { type: "t", id: "phc" }, lines: [{ accountId: acct("5400"), debit: "60" }, { accountId: acct("1200"), credit: "60" }] });
    const range = { from: new Date(`${Y}-01-01T00:00:00+04:00`), to: new Date(Date.now() + 86400000) };
    const b = await branchProfitability(fin, range);
    const sumBranch = b.rows.reduce((a, r) => a.plus(r.net), money(0));
    expect(sumBranch.plus(b.unassignedNet).toFixed(2)).toBe(b.consolidatedNet.toFixed(2));
    const pm = await pharmacyMargin(fin, range);
    expect(pm.grossMargin.toFixed(2)).toBe("40.00");
    expect(pm.marginPct).toBeCloseTo(40);
  });

  it("books still balance", async () => {
    const tb = await trialBalance(fin, {});
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
  });
});

describe("journal approval, period close, year-end close", () => {
  it("adjusting journals need a different approver; rejection needs a reason; pending journals block period close", async () => {
    const draft = await submitJournalForApproval(fin, { date: new Date(), memo: "accrue rent", sourceRef: { type: "adj", id: "r1" }, lines: [{ accountId: acct("5100"), debit: "500" }, { accountId: acct("2300"), credit: "500" }] });
    await expect(decideDraftJournal(fin, draft._id, true)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decideDraftJournal(acc, draft._id, true)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const now = new Date(Date.now() + 4 * 3600_000);
    await expect(closePeriod(fin2, now.getUTCFullYear(), now.getUTCMonth() + 1)).rejects.toMatchObject({ code: "CONFLICT" });
    const rent0 = await bal("5100");
    const je = await decideDraftJournal(fin2, draft._id, true);
    expect(je?.entryNo).toBeGreaterThan(0);
    expect((await bal("5100")).minus(rent0).toFixed(2)).toBe("500.00");
    await expect(decideDraftJournal(fin2, draft._id, true)).rejects.toMatchObject({ code: "CONFLICT" });
    const d2 = await submitJournalForApproval(acc, { date: new Date(), memo: "wrong accrual", sourceRef: { type: "adj", id: "r2" }, lines: [{ accountId: acct("5100"), debit: "1" }, { accountId: acct("2300"), credit: "1" }] });
    await expect(decideDraftJournal(fin, d2._id, false)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await decideDraftJournal(fin, d2._id, false, "not supported by invoice")).toBeNull();
  });

  it("year-end close moves net income to retained earnings once, locks the year, and blocks later postings", async () => {
    const C = "org-fin-close", cf = ctxFor(["finance_manager"], C, "f1", "br1");
    await ensureChartOfAccounts(C);
    await periods(C, [Y]);
    const a = (c: string) => `${C}:${c}`;
    await postJournal(cf, { date: new Date(`${Y}-03-15T12:00:00+04:00`), memo: "sales", idempotencyKey: "y-s", sourceRef: { type: "t", id: "1" }, lines: [{ accountId: a("1000"), debit: "1000" }, { accountId: a("4000"), credit: "1000" }] });
    await postJournal(cf, { date: new Date(`${Y}-04-15T12:00:00+04:00`), memo: "rent", idempotencyKey: "y-r", sourceRef: { type: "t", id: "2" }, lines: [{ accountId: a("5100"), debit: "300" }, { accountId: a("1000"), credit: "300" }] });
    const entry = await closeFiscalYear(cf, Y);
    expect(entry).not.toBeNull();
    const again = await closeFiscalYear(cf, Y);
    expect(again?._id).toBe(entry?._id);
    const tb = await trialBalance(cf, {});
    const row = (code: string) => tb.rows.find((r) => r.code === code)?.balance.toFixed(2);
    expect(row("4000")).toBe("0.00");
    expect(row("5100")).toBe("0.00");
    expect(row("3100")).toBe("-700.00"); // retained earnings credit
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
    await expect(postJournal(cf, { date: new Date(`${Y}-05-01T12:00:00+04:00`), memo: "late", idempotencyKey: "y-late", sourceRef: { type: "t", id: "3" }, lines: [{ accountId: a("1000"), debit: "1" }, { accountId: a("4000"), credit: "1" }] })).rejects.toMatchObject({ code: "PERIOD_LOCKED" });
  });
});
