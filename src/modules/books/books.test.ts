import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { money, fromDecimal128 } from "@/core/money";
import { ctxFor } from "@/test/helpers";
import { ensureChartOfAccounts } from "@/modules/ledger/accounts";
import { trialBalance } from "@/modules/reports/trialBalance";
import { createSupplier } from "@/modules/procurement/service";
import { generalLedger, createAccount, setAccountActive } from "@/modules/ledger/coa";
import * as bk from "./service";

const ORG = "org-books";
const Y = new Date().getUTCFullYear();
const acc = ctxFor(["accountant"], ORG, "acc1", "br1");
const fin = ctxFor(["finance_manager"], ORG, "fin1", "br1");
let n = 0;
const k = () => `bk-${n++}`;

async function bal(code: string) {
  const tb = await trialBalance(fin, {});
  return tb.rows.find((r) => r.code === code)?.balance ?? money(0);
}

describe("business books", () => {
  beforeAll(async () => {
    await ensureIndexes();
    await ensureChartOfAccounts(ORG);
    for (const year of [Y - 1, Y, Y + 1]) for (let m = 1; m <= 12; m++)
      await tenantCol<any>(ORG, "fiscal_periods").insertOne({ _id: `${ORG}:${year}-${m}`, year, month: m, status: "open", start: new Date(Date.UTC(year, m - 1, 1, -4)), end: new Date(Date.UTC(year, m, 1, -4)) });
  });
  afterAll(closeClient);

  it("parses lines and computes VAT per line", () => {
    const t = bk.totalsOf(bk.parseLines("Medicals | 10 | 100 | STD\nVaccines | 2 | 50.50 | ZERO", "4500"));
    expect(t.net.toFixed(2)).toBe("1101.00");
    expect(t.vat.toFixed(2)).toBe("50.00");
    expect(t.total.toFixed(2)).toBe("1151.00");
    expect(() => bk.parseLines("Bad | 1 | abc", "4500")).toThrow();
    expect(() => bk.parseLines("", "4500")).toThrow();
  });

  it("invoice -> receipt -> credit note keeps AR, revenue and VAT tied", async () => {
    const c = await bk.createCustomer(acc, { name: "Gulf Logistics LLC", termsDays: 30 });
    const inv = await bk.createInvoice(acc, { customerId: c._id, lines: bk.parseLines("Pre-employment medicals | 10 | 100 | STD", "4500"), issue: true, idempotencyKey: k() });
    expect(inv.status).toBe("open");
    expect((await bal("1120")).toFixed(2)).toBe("1050.00");
    expect((await bal("4500")).toFixed(2)).toBe("-1000.00");
    expect((await bal("2100")).toFixed(2)).toBe("-50.00");

    const r1 = await bk.recordReceipt(acc, { customerId: c._id, invoiceId: inv._id, amount: "500.00", method: "bank", idempotencyKey: k() });
    expect(fromDecimal128(r1.unapplied).isZero()).toBe(true);
    expect((await bal("1120")).toFixed(2)).toBe("550.00");
    await expect(bk.recordReceipt(acc, { customerId: c._id, invoiceId: inv._id, amount: "9999.00", method: "bank", idempotencyKey: k() })).rejects.toThrow();

    const key = k();
    const a = await bk.recordReceipt(acc, { customerId: c._id, invoiceId: inv._id, amount: "100.00", method: "cash", idempotencyKey: key });
    const b = await bk.recordReceipt(acc, { customerId: c._id, invoiceId: inv._id, amount: "100.00", method: "cash", idempotencyKey: key });
    expect(b._id).toBe(a._id);
    expect((await bal("1120")).toFixed(2)).toBe("450.00");

    const cn = await bk.issueTradeCreditNote(acc, { customerId: c._id, invoiceId: inv._id, lines: bk.parseLines("Returned: 1 medical | 1 | 100 | STD", "4500"), reason: "Employee did not attend", idempotencyKey: k() });
    expect(fromDecimal128(cn.total).toFixed(2)).toBe("105.00");
    expect((await bal("1120")).toFixed(2)).toBe("345.00");
    const [row] = (await bk.listTradeInvoices(acc)).filter((i) => i._id === inv._id);
    expect(fromDecimal128(row.balance).toFixed(2)).toBe("345.00");

    const st = await bk.customerStatement(acc, c._id);
    expect(st.balance.toFixed(2)).toBe("345.00");
    const ag = await bk.tradeAging(acc);
    expect(ag.total.toFixed(2)).toBe((await bal("1120")).toFixed(2));
  });

  it("on-account receipt can be applied later; no journal on apply", async () => {
    const c = await bk.createCustomer(acc, { name: "Desert Rose Hotels" });
    const inv = await bk.createInvoice(acc, { customerId: c._id, lines: bk.parseLines("Staff clinic plan | 1 | 2000 | ZERO", "4500"), issue: true, idempotencyKey: k() });
    const r = await bk.recordReceipt(acc, { customerId: c._id, amount: "2000.00", method: "bank", idempotencyKey: k() });
    expect(fromDecimal128(r.unapplied).toFixed(2)).toBe("2000.00");
    const before = await tenantCol(ORG, "journal_entries").count({});
    await bk.applyCredit(acc, { source: "receipt", sourceId: r._id, invoiceId: inv._id });
    expect(await tenantCol(ORG, "journal_entries").count({})).toBe(before);
    expect((await bk.listTradeInvoices(acc)).find((i) => i._id === inv._id)!.status).toBe("paid");
  });

  it("draft invoices post nothing until issued; voiding reverses", async () => {
    const c = await bk.createCustomer(acc, { name: "Draft Co" });
    const before = await bal("1120");
    const inv = await bk.createInvoice(acc, { customerId: c._id, lines: bk.parseLines("Consult pack | 1 | 300 | STD", "4500"), issue: false, idempotencyKey: k() });
    expect((await bal("1120")).equals(before)).toBe(true);
    await bk.issueInvoice(acc, inv._id);
    expect((await bal("1120")).minus(before).toFixed(2)).toBe("315.00");
    await expect(bk.voidInvoice(acc, inv._id, "wrong customer")).rejects.toThrow(); // accountant cannot approve
    await bk.voidInvoice(fin, inv._id, "wrong customer");
    expect((await bal("1120")).equals(before)).toBe(true);
  });

  it("estimate converts to sales order then draft invoice, once", async () => {
    const c = await bk.createCustomer(acc, { name: "Convert Co" });
    const e = await bk.createSalesDoc(acc, { kind: "estimate", customerId: c._id, lines: bk.parseLines("Wellness day | 1 | 5000 | STD", "4500") });
    await bk.setSalesDocStatus(acc, e._id, "accepted");
    const so = await bk.convertSalesDoc(acc, e._id, "sales_order");
    await expect(bk.convertSalesDoc(acc, e._id, "invoice")).rejects.toThrow();
    const inv = await bk.convertSalesDoc(acc, so.id, "invoice");
    expect((await bk.listTradeInvoices(acc)).find((i) => i._id === inv.id)!.status).toBe("draft");
  });

  it("recurring profile generates once per due date", async () => {
    const c = await bk.createCustomer(acc, { name: "Rent Tenant" });
    const r = await bk.createRecurring(acc, { name: "Pharmacy kiosk rent", customerId: c._id, frequency: "monthly", startDate: new Date(Date.now() - 40 * 86400000), lines: bk.parseLines("Rent | 1 | 4000 | STD | 4800", "4500") });
    const made = await bk.runDueRecurring(acc);
    expect(made).toBeGreaterThanOrEqual(2);
    expect(await bk.runDueRecurring(acc)).toBe(0);
    const again = (await tenantCol<any>(ORG, "recurring_invoices").findOne({ _id: r._id }))!;
    expect(again.nextDate.getTime()).toBeGreaterThan(Date.now());
  });

  it("vendor credit reduces the bill and AP; expense and input VAT are reversed", async () => {
    const sup = await createSupplier(acc, { name: "MedSupply FZ" });
    await tenantCol<any>(ORG, "supplier_invoices").insertOne({ _id: "si-1", supplierId: sup._id, invoiceNo: "X1", status: "approved", paid: money(0).toFixed() as never, balance: (await import("@/core/money")).toDecimal128(money("210.00")) });
    await tenantCol<any>(ORG, "supplier_invoices").updateOne({ _id: "si-1" }, { $set: { paid: (await import("@/core/money")).toDecimal128(money(0)) } });
    const ap0 = await bal("2000");
    const vc = await bk.recordVendorCredit(acc, { supplierId: sup._id, supplierInvoiceId: "si-1", lines: bk.parseLines("Damaged goods returned | 1 | 100 | STD | 5300", "5800"), reason: "Damaged on delivery", idempotencyKey: k() });
    expect(fromDecimal128(vc.total).toFixed(2)).toBe("105.00");
    expect(ap0.minus(await bal("2000")).toFixed(2)).toBe("-105.00");
    const si = (await tenantCol<any>(ORG, "supplier_invoices").findOne({ _id: "si-1" }))!;
    expect(fromDecimal128(si.balance).toFixed(2)).toBe("105.00");
  });

  it("bank transfer, deposit and withdrawal post balanced entries", async () => {
    await bk.bankTransaction(acc, { type: "deposit", account: "bank", otherCode: "3000", amount: "10000.00", description: "Owner capital", idempotencyKey: k() });
    await bk.bankTransaction(acc, { type: "transfer", account: "cash", otherCode: "bank", amount: "1000.00", description: "Cash float", idempotencyKey: k() });
    await bk.bankTransaction(acc, { type: "withdrawal", account: "bank", otherCode: "5810", amount: "25.00", description: "Bank charges", idempotencyKey: k() });
    expect((await bal("1000")).toFixed(2)).toBe("1100.00"); // 1,000 transfer + 100 earlier cash receipt
    const tb = await trialBalance(fin, {});
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
  });

  it("general ledger running balance, chart edits and lock-through", async () => {
    const gl = await generalLedger(fin, { code: "1120", from: new Date(Date.UTC(Y - 1, 0, 1)), to: new Date(Date.UTC(Y + 2, 0, 1)) });
    expect(gl.closing.equals(await bal("1120"))).toBe(true);
    const a = await createAccount(fin, { code: "5990", name: "Training and Conferences", type: "expense" });
    expect(a.normal).toBe("debit");
    await expect(createAccount(fin, { code: "6990", name: "Wrong range", type: "expense" })).rejects.toThrow();
    await expect(setAccountActive(fin, "1120", false)).rejects.toThrow(); // system account
    await setAccountActive(fin, "5990", false);
    const locked = await bk.lockThrough(fin, Y - 1, 12);
    expect(locked).toBe(12);
    await expect(bk.createInvoice(acc, { customerId: (await bk.listCustomers(acc))[0]._id, issueDate: new Date(Date.UTC(Y - 1, 5, 10, 8)), lines: bk.parseLines("Late | 1 | 10 | ZERO", "4500"), issue: true, idempotencyKey: k() })).rejects.toThrow();
  });
});
