import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { toDecimal128, money, fromDecimal128 } from "@/core/money";
import { ctxFor } from "@/test/helpers";
import { ensureChartOfAccounts } from "@/modules/ledger/accounts";
import { trialBalance } from "@/modules/reports/trialBalance";
import { createPatient } from "@/modules/patients/service";
import { finalizeInvoice, issueCreditNote } from "./invoice";
import { recordPayment, refundPayment } from "./payment";

const ORG = "org-invoice";
const reg = ctxFor(["receptionist"], ORG, "recep", "br1");
const acc = ctxFor(["accountant"], ORG, "acc", "br1");
const fin = ctxFor(["finance_manager"], ORG, "fin", "br1");
let pn = 0;

async function seedCharge(patientId: string, price = "250.00", rate = "5", rev = "rev_consultation") {
  const id = `ch-${Math.random().toString(36).slice(2)}`;
  await tenantCol<any>(ORG, "charges").insertOne({
    _id: id, patientId, encounterId: "enc-x", serviceId: "svc", serviceCode: "CONS", name: "Consultation", kind: "consultation", qty: 1,
    unitPrice: toDecimal128(money(price)), taxCode: "STD", taxRate: toDecimal128(money(rate)), revenueAccountSystem: rev,
    status: "unbilled", createdAt: new Date(), createdBy: "x",
  });
  return id;
}
async function patient() {
  const p = await createPatient(reg, { fullName: `Inv Patient ${pn++}`, dob: "1980-01-01", sex: "male", phone: `+9715550${4000 + pn}` });
  return p._id;
}
async function glBalance(system: string) {
  const tb = await trialBalance(fin, {});
  const row = tb.rows.find((r) => r.code === system);
  return row ? row.balance : money(0);
}

beforeAll(async () => {
  await ensureIndexes();
  await ensureChartOfAccounts(ORG);
  const y = new Date().getUTCFullYear();
  for (const year of [y - 1, y, y + 1]) for (let m = 1; m <= 12; m++)
    await tenantCol<any>(ORG, "fiscal_periods").insertOne({ _id: `${ORG}:${year}-${m}`, year, month: m, status: "open", start: new Date(Date.UTC(year, m - 1, 1, -4)), end: new Date(Date.UTC(year, m, 1, -4)) });
});
afterAll(async () => { await closeClient(); });

describe("finalizeInvoice", () => {
  it("computes VAT per line and posts Dr AR / Cr Revenue / Cr VAT", async () => {
    const p = await patient();
    const c = await seedCharge(p);
    const inv = await finalizeInvoice(reg, { patientId: p, chargeIds: [c] });
    expect(inv.number).toMatch(/^INV-\d{4}-\d{6}$/);
    expect(fromDecimal128(inv.subtotal).toFixed(2)).toBe("250.00");
    expect(fromDecimal128(inv.vatTotal).toFixed(2)).toBe("12.50");
    expect(fromDecimal128(inv.total).toFixed(2)).toBe("262.50");
    const je = await tenantCol<any>(ORG, "journal_entries").findOne({ _id: inv.journalEntryId });
    const byAcc = Object.fromEntries(je.lines.map((l: any) => [l.accountId.split(":")[1], [fromDecimal128(l.debit).toFixed(2), fromDecimal128(l.credit).toFixed(2)]]));
    expect(byAcc["1100"]).toEqual(["262.50", "0.00"]);
    expect(byAcc["4000"]).toEqual(["0.00", "250.00"]);
    expect(byAcc["2100"]).toEqual(["0.00", "12.50"]);
    expect((await tenantCol<any>(ORG, "charges").findOne({ _id: c })).status).toBe("invoiced");
  });

  it("finalizing twice (sequential and parallel) yields one invoice and one journal", async () => {
    const p = await patient();
    const c = await seedCharge(p);
    const rs = await Promise.all([1, 2, 3, 4].map(() => finalizeInvoice(reg, { patientId: p, chargeIds: [c] })));
    expect(new Set(rs.map((r) => r._id)).size).toBe(1);
    const again = await finalizeInvoice(reg, { patientId: p, chargeIds: [c] });
    expect(again._id).toBe(rs[0]._id);
    expect(await tenantCol<any>(ORG, "invoices").count({ patientId: p })).toBe(1);
    expect(await tenantCol<any>(ORG, "journal_entries").count({ "sourceRef.id": rs[0]._id })).toBe(1);
  });

  it("rejects empty set, other patient's charges, and other orgs", async () => {
    const p = await patient(), q = await patient();
    const c = await seedCharge(q);
    await expect(finalizeInvoice(reg, { patientId: p, chargeIds: [] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(finalizeInvoice(reg, { patientId: p, chargeIds: [c] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(finalizeInvoice(ctxFor(["receptionist"], "other-org"), { patientId: q, chargeIds: [c] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(finalizeInvoice(ctxFor(["nurse"], ORG), { patientId: q, chargeIds: [c] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("payments", () => {
  it("invoice + full payment leaves the patient's AR at zero", async () => {
    const before = await glBalance("1100");
    const p = await patient();
    const inv = await finalizeInvoice(reg, { patientId: p, chargeIds: [await seedCharge(p, "100.00", "5")] });
    const pay = await recordPayment(reg, { invoiceId: inv._id, method: "cash", amount: "105.00", idempotencyKey: `pay-${inv._id}` });
    expect(pay.receiptNo).toMatch(/^RCP-/);
    const after = await tenantCol<any>(ORG, "invoices").findOne({ _id: inv._id });
    expect(fromDecimal128(after.balance).toFixed(2)).toBe("0.00");
    expect(after.status).toBe("paid");
    expect((await glBalance("1100")).minus(before).toFixed(2)).toBe("0.00");
  });

  it("retry with the same idempotency key creates one payment and one journal entry", async () => {
    const p = await patient();
    const inv = await finalizeInvoice(reg, { patientId: p, chargeIds: [await seedCharge(p, "200.00", "0")] });
    const key = `retry-${inv._id}`;
    const rs = await Promise.all(Array.from({ length: 5 }, () => recordPayment(reg, { invoiceId: inv._id, method: "card", amount: "50.00", idempotencyKey: key })));
    expect(new Set(rs.map((r) => r._id)).size).toBe(1);
    expect(await tenantCol<any>(ORG, "payments").count({ invoiceId: inv._id })).toBe(1);
    const after = await tenantCol<any>(ORG, "invoices").findOne({ _id: inv._id });
    expect(fromDecimal128(after.paid).toFixed(2)).toBe("50.00");
    expect(after.status).toBe("partially_paid");
  });

  it("split payments settle the invoice; overpayment becomes a customer advance", async () => {
    const p = await patient();
    const inv = await finalizeInvoice(reg, { patientId: p, chargeIds: [await seedCharge(p, "100.00", "0")] });
    await recordPayment(reg, { invoiceId: inv._id, method: "cash", amount: "60.00", idempotencyKey: `s1-${inv._id}` });
    const adv0 = await glBalance("2400");
    const last = await recordPayment(reg, { invoiceId: inv._id, method: "card", amount: "50.00", idempotencyKey: `s2-${inv._id}` });
    expect(fromDecimal128(last.advance).toFixed(2)).toBe("10.00");
    expect((await glBalance("2400")).minus(adv0).toFixed(2)).toBe("-10.00"); // credit-normal: more negative = more liability
    const after = await tenantCol<any>(ORG, "invoices").findOne({ _id: inv._id });
    expect(after.status).toBe("paid");
  });

  it("rejects bad amounts, wrong role and cross-org", async () => {
    const p = await patient();
    const inv = await finalizeInvoice(reg, { patientId: p, chargeIds: [await seedCharge(p, "10.00", "0")] });
    await expect(recordPayment(reg, { invoiceId: inv._id, method: "cash", amount: "0", idempotencyKey: "z1" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(recordPayment(reg, { invoiceId: inv._id, method: "cash", amount: "1.005", idempotencyKey: "z2" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(recordPayment(ctxFor(["nurse"], ORG), { invoiceId: inv._id, method: "cash", amount: "1", idempotencyKey: "z3" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(recordPayment(ctxFor(["receptionist"], "other-org"), { invoiceId: inv._id, method: "cash", amount: "1", idempotencyKey: "z4" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("credit notes and refunds", () => {
  it("credit note on an unpaid invoice reverses revenue, VAT and AR", async () => {
    const before = await glBalance("1100");
    const p = await patient();
    const inv = await finalizeInvoice(reg, { patientId: p, chargeIds: [await seedCharge(p, "100.00", "5")] });
    const cn = await issueCreditNote(acc, { invoiceId: inv._id, reason: "billed in error" });
    expect(cn.number).toMatch(/^CN-/);
    expect((await glBalance("1100")).minus(before).toFixed(2)).toBe("0.00");
    expect((await tenantCol<any>(ORG, "invoices").findOne({ _id: inv._id })).status).toBe("credited");
    await expect(issueCreditNote(acc, { invoiceId: inv._id, reason: "again" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(issueCreditNote(reg, { invoiceId: inv._id, reason: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("credit note is refused while payments stand; refund then credit note works", async () => {
    const p = await patient();
    const inv = await finalizeInvoice(reg, { patientId: p, chargeIds: [await seedCharge(p, "100.00", "0")] });
    const pay = await recordPayment(reg, { invoiceId: inv._id, method: "cash", amount: "100.00", idempotencyKey: `cn-${inv._id}` });
    await expect(issueCreditNote(acc, { invoiceId: inv._id, reason: "x" })).rejects.toMatchObject({ code: "CONFLICT" });
    await refundPayment(acc, { paymentId: pay._id, amount: "100.00", reason: "service not rendered", idempotencyKey: `rf-${pay._id}` });
    const mid = await tenantCol<any>(ORG, "invoices").findOne({ _id: inv._id });
    expect(fromDecimal128(mid.balance).toFixed(2)).toBe("100.00");
    await issueCreditNote(acc, { invoiceId: inv._id, reason: "service not rendered" });
  });

  it("refund cannot exceed what was paid; is idempotent", async () => {
    const p = await patient();
    const inv = await finalizeInvoice(reg, { patientId: p, chargeIds: [await seedCharge(p, "100.00", "0")] });
    const pay = await recordPayment(reg, { invoiceId: inv._id, method: "cash", amount: "40.00", idempotencyKey: `ov-${inv._id}` });
    await expect(refundPayment(acc, { paymentId: pay._id, amount: "40.01", reason: "r", idempotencyKey: "r1" })).rejects.toMatchObject({ code: "VALIDATION" });
    const a = await refundPayment(acc, { paymentId: pay._id, amount: "10.00", reason: "r", idempotencyKey: "r2" });
    const b = await refundPayment(acc, { paymentId: pay._id, amount: "10.00", reason: "r", idempotencyKey: "r2" });
    expect(b._id).toBe(a._id);
    await expect(refundPayment(reg, { paymentId: pay._id, amount: "1.00", reason: "r", idempotencyKey: "r3" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("ledger stays balanced after all of the above", async () => {
    const tb = await trialBalance(fin, {});
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
  });
});
