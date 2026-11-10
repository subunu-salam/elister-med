import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol, withTransaction } from "@/core/db";
import { money, fromDecimal128, toDecimal128 } from "@/core/money";
import { ctxFor } from "@/test/helpers";
import { ensureChartOfAccounts } from "@/modules/ledger/accounts";
import { trialBalance } from "@/modules/reports/trialBalance";
import { createPatient } from "@/modules/patients/service";
import { createItem, receiveIntoStock, listBatches, stockOnHand, inventoryValuation } from "@/modules/inventory/service";
import { listUnbilledCharges } from "@/modules/billing/charges";
import { finalizeInvoice } from "@/modules/billing/invoice";
import {
  createPrescription, signPrescription, verifyPrescription, dispense, dispensingQueue, returnMedication, requestRefill, decideRefill, pharmacyDashboard,
} from "./service";

const ORG = "org-rx";
const reg = ctxFor(["receptionist"], ORG, "recep", "br1");
const doctor = ctxFor(["doctor"], ORG, "doc1", "br1");
const doctor2 = ctxFor(["doctor"], ORG, "doc2", "br1");
const pharm = ctxFor(["pharmacist"], ORG, "ph1", "br1");
const fin = ctxFor(["finance_manager"], ORG, "fin1", "br1");
const future = (d: number) => new Date(Date.now() + d * 86400000);
let patientId = "", para = "", amox = "", morphine = "", enc = "";

async function bal(code: string) {
  const tb = await trialBalance(fin, {});
  return tb.rows.find((r) => r.code === code)?.balance ?? money(0);
}
async function stock(itemId: string, batchNo: string, expiryDays: number, qty: number, cost: string) {
  await withTransaction(async (s) => {
    const { value } = await receiveIntoStock(pharm, { itemId, locationId: "pharmacy", batchNo, expiry: future(expiryDays), qty, unitCost: money(cost), refType: "test", refId: batchNo }, s);
    // post the matching GL so valuation reconciles
    const { postJournalSystem } = await import("@/modules/ledger/journal");
    const { accountBySystem } = await import("@/modules/ledger/accounts");
    await postJournalSystem(fin, { date: new Date(), memo: "opening stock", sourceRef: { type: "test", id: batchNo }, idempotencyKey: `open:${batchNo}`, lines: [
      { accountId: (await accountBySystem(ORG, "inventory_pharmacy"))._id, debit: value.toFixed(2) }, { accountId: (await accountBySystem(ORG, "capital"))._id, credit: value.toFixed(2) }] }, s);
  });
}

beforeAll(async () => {
  await ensureIndexes();
  await ensureChartOfAccounts(ORG);
  await tenantCol<any>(ORG, "accounts").updateOne({ code: "3000" }, { $set: { system: "capital" } });
  const y = new Date().getUTCFullYear();
  for (const year of [y - 1, y, y + 1]) for (let m = 1; m <= 12; m++)
    await tenantCol<any>(ORG, "fiscal_periods").insertOne({ _id: `${ORG}:${year}-${m}`, year, month: m, status: "open", start: new Date(Date.UTC(year, m - 1, 1, -4)), end: new Date(Date.UTC(year, m, 1, -4)) });
  await tenantCol<any>(ORG, "tax_codes").insertOne({ _id: `${ORG}:t`, code: "STD", rate: toDecimal128(money("5")), kind: "standard", reviewRequired: true });
  patientId = (await createPatient(reg, { fullName: "Rx Patient", dob: "1990-03-03", sex: "female", phone: "+971508880001", allergies: [{ substance: "Amoxicillin", severity: "severe" }] }))._id;
  await tenantCol<any>(ORG, "encounters").insertOne({ _id: "enc-rx", patientId, doctorId: "d", branchId: "br1", appointmentId: "a", status: "open", diagnoses: [], vitals: [], openedAt: new Date(), openedBy: "x" });
  enc = "enc-rx";
  para = (await createItem(pharm, { sku: "PARA-500", name: "Paracetamol 500mg", genericName: "paracetamol", category: "medicine", sellingPrice: "5.00", reorderLevel: 5, reorderQty: 50 }))._id;
  amox = (await createItem(pharm, { sku: "AMOX-500R", name: "Amoxicillin 500mg", genericName: "amoxicillin", category: "medicine", sellingPrice: "25.00" }))._id;
  morphine = (await createItem(pharm, { sku: "MORPH-10", name: "Morphine 10mg", category: "medicine", controlled: true, sellingPrice: "40.00" }))._id;
  await stock(para, "P-SOON", 60, 10, "1.00");
  await stock(para, "P-LATE", 200, 20, "1.50");
  await stock(amox, "A-1", 300, 30, "8.00");
});
afterAll(async () => { await closeClient(); });

const line = (itemId: string, qty: number, extra = {}) => ({ itemId, dose: "1 tab", frequency: "TDS", durationDays: 5, qty, ...extra });

describe("Scenario D: prescription to dispensing", () => {
  let rxId = "", dispId = "";

  it("controlled medicines cannot be prescribed electronically", async () => {
    await expect(createPrescription(doctor, { encounterId: enc, lines: [line(morphine, 5)] })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("allergy match is flagged, blocks signing without an override, and interaction checking is honestly marked as not performed", async () => {
    const rx = await createPrescription(doctor, { encounterId: enc, lines: [line(amox, 10)] });
    expect(rx.alerts.map((a) => a.type)).toEqual(expect.arrayContaining(["allergy", "interaction_not_checked"]));
    expect(rx.alerts.find((a) => a.type === "interaction_not_checked")!.message).toMatch(/NOT performed/);
    await expect(signPrescription(doctor, rx._id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(signPrescription(doctor2, rx._id, { overrideReason: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" }); // not the prescriber
    await signPrescription(doctor, rx._id, { overrideReason: "Tolerated previously per patient; monitored" });
  });

  it("doctor signs, pharmacist verifies; unverified/unsigned prescriptions cannot be dispensed", async () => {
    const rx = await createPrescription(doctor, { encounterId: enc, lines: [line(para, 20, { substitutionAllowed: false })] });
    rxId = rx._id;
    await expect(dispense(pharm, { prescriptionId: rxId, locationId: "pharmacy", idempotencyKey: "d0", lines: [{ itemId: para, qty: 1 }] })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(signPrescription(pharm, rxId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await signPrescription(doctor, rxId);
    expect((await dispensingQueue(pharm)).map((r) => r._id)).toContain(rxId);
    await expect(verifyPrescription(doctor, rxId, { patientConfirmed: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(verifyPrescription(pharm, rxId, { patientConfirmed: false })).rejects.toMatchObject({ code: "VALIDATION" });
    await verifyPrescription(pharm, rxId, { patientConfirmed: true });
  });

  it("partial dispensing deducts FEFO batches, posts COGS at batch cost, and creates one unbilled charge", async () => {
    const cogs0 = await bal("5400"), inv0 = await bal("1200");
    const d = await dispense(pharm, { prescriptionId: rxId, locationId: "pharmacy", idempotencyKey: "dsp-1", lines: [{ itemId: para, qty: 15 }] });
    dispId = d._id;
    expect(d.lines[0].allocations.map((a) => [a.batchNo, a.qty])).toEqual([["P-SOON", 10], ["P-LATE", 5]]);
    expect((await bal("5400")).minus(cogs0).toFixed(2)).toBe("17.50"); // 10 x 1.00 + 5 x 1.50
    expect(inv0.minus(await bal("1200")).toFixed(2)).toBe("17.50");
    const batches = await listBatches(pharm, para);
    expect(batches.map((b) => [b.batchNo, b.qtyOnHand])).toEqual([["P-LATE", 15]]); // P-SOON emptied
    const charges = await listUnbilledCharges(reg, patientId);
    const ch = charges.find((c) => c.serviceCode === "PARA-500")!;
    expect(ch.qty).toBe(15);
    expect((await tenantCol<any>(ORG, "prescriptions").findOne({ _id: rxId })).status).toBe("partially_dispensed");
  });

  it("is idempotent, cannot over-dispense, and rolls back fully on insufficient stock", async () => {
    const again = await dispense(pharm, { prescriptionId: rxId, locationId: "pharmacy", idempotencyKey: "dsp-1", lines: [{ itemId: para, qty: 15 }] });
    expect(again._id).toBe(dispId);
    expect((await stockOnHand(pharm, para)).total).toBe(15);
    await expect(dispense(pharm, { prescriptionId: rxId, locationId: "pharmacy", idempotencyKey: "dsp-2", lines: [{ itemId: para, qty: 6 }] })).rejects.toMatchObject({ code: "VALIDATION" });
    // a prescription for more than is in stock: nothing may change
    const big = await createPrescription(doctor, { encounterId: enc, lines: [line(para, 100)] });
    await signPrescription(doctor, big._id);
    await verifyPrescription(pharm, big._id, { patientConfirmed: true });
    const before = await stockOnHand(pharm, para);
    await expect(dispense(pharm, { prescriptionId: big._id, locationId: "pharmacy", idempotencyKey: "dsp-big", lines: [{ itemId: para, qty: 100 }] })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await stockOnHand(pharm, para)).toEqual(before);
  });

  it("duplicate prescribing is warned about", async () => {
    const dup = await createPrescription(doctor, { encounterId: enc, lines: [line(para, 5)] });
    expect(dup.alerts.map((a) => a.type)).toContain("duplicate");
  });

  it("substitution needs prescriber permission on the line and a pharmacist", async () => {
    const other = (await createItem(pharm, { sku: "PARA-GEN", name: "Paracetamol generic 500mg", genericName: "paracetamol", category: "medicine", sellingPrice: "4.00" }))._id;
    await stock(other, "G-1", 100, 10, "0.80");
    const rx = await createPrescription(doctor, { encounterId: enc, lines: [line(para, 2, { substitutionAllowed: true }), line(amox, 0 + 1, { substitutionAllowed: false })].slice(0, 1) });
    await signPrescription(doctor, rx._id);
    await verifyPrescription(pharm, rx._id, { patientConfirmed: true });
    const d = await dispense(pharm, { prescriptionId: rx._id, locationId: "pharmacy", idempotencyKey: "dsp-sub", lines: [{ itemId: para, qty: 2, substituteItemId: other }] });
    expect(d.lines[0].substitute).toBe(true);
    const nosub = await createPrescription(doctor, { encounterId: enc, lines: [line(para, 1)] });
    await signPrescription(doctor, nosub._id);
    await verifyPrescription(pharm, nosub._id, { patientConfirmed: true });
    await expect(dispense(pharm, { prescriptionId: nosub._id, locationId: "pharmacy", idempotencyKey: "dsp-nosub", lines: [{ itemId: para, qty: 1, substituteItemId: other }] })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("returns restore the original batch, reverse COGS and reduce the unbilled charge", async () => {
    const cogs0 = await bal("5400");
    await expect(returnMedication(pharm, { dispensingId: dispId, itemId: para, qty: 16, reason: "x" })).rejects.toMatchObject({ code: "VALIDATION" });
    await returnMedication(pharm, { dispensingId: dispId, itemId: para, qty: 3, reason: "patient declined" });
    expect(cogs0.minus(await bal("5400")).toFixed(2)).toBe("4.50"); // returned from the later batch @1.50
    const ch = (await listUnbilledCharges(reg, patientId)).find((c) => c.serviceCode === "PARA-500" && c.qty === 12);
    expect(ch).toBeTruthy();
  });

  it("refill: request -> prescriber approves -> NEW DRAFT prescription (never auto-signed)", async () => {
    const rf = await requestRefill(pharm, rxId, "patient asked for repeat");
    const draft = await decideRefill(doctor, rf._id, true);
    expect(draft?.status).toBe("draft");
    expect(draft?.refillOf).toBe(rxId);
    await expect(decideRefill(doctor, rf._id, true)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("dispensed items bill with 5% VAT into pharmacy revenue", async () => {
    const charges = (await listUnbilledCharges(reg, patientId)).filter((c) => c.kind === "pharmacy");
    const inv = await finalizeInvoice(reg, { patientId, chargeIds: charges.map((c) => c._id) });
    const je = await tenantCol<any>(ORG, "journal_entries").findOne({ _id: inv.journalEntryId });
    expect(je.lines.some((l: any) => l.accountId.endsWith(":4300") && fromDecimal128(l.credit).gt(0))).toBe(true);
    expect(fromDecimal128(inv.vatTotal).gt(0)).toBe(true);
  });

  it("inventory valuation equals the GL; books balance; dashboard reads real data", async () => {
    expect((await bal("1200")).toFixed(2)).toBe((await inventoryValuation(pharm)).total.toFixed(2));
    const tb = await trialBalance(fin, {});
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
    const dash = await pharmacyDashboard(pharm);
    expect(dash.medicines).toBeGreaterThanOrEqual(3);
    expect(Number(dash.pharmacySales)).toBeGreaterThan(0);
  });

  it("org isolation", async () => {
    await expect(createPrescription(ctxFor(["doctor"], "other-org", "x"), { encounterId: enc, lines: [line(para, 1)] })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
