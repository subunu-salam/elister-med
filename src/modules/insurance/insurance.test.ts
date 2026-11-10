import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { toDecimal128, money, fromDecimal128 } from "@/core/money";
import { ctxFor } from "@/test/helpers";
import { ensureChartOfAccounts } from "@/modules/ledger/accounts";
import { trialBalance } from "@/modules/reports/trialBalance";
import { createPatient } from "@/modules/patients/service";
import { recordPayment } from "@/modules/billing/payment";
import { createPayer, createPlan, createPolicy, recordEligibility, requestPreauth, decidePreauth } from "./masters";
import {
  finalizeInsuredInvoice, validateClaim, submitClaim, recordPayerResponse, resubmitClaim, postRemittance, writeOffClaim, insuranceReceivables,
} from "./claims";

const ORG = "org-ins";
const reg = ctxFor(["receptionist"], ORG, "recep", "br1");
const coord = ctxFor(["insurance_coordinator"], ORG, "coord", "br1");
const fin = ctxFor(["finance_manager"], ORG, "fin", "br1");
let patientId = "", policyId = "", payerId = "", planId = "";

async function seedCharge(encId: string) {
  const id = `ic-${Math.random().toString(36).slice(2)}`;
  await tenantCol<any>(ORG, "charges").insertOne({
    _id: id, patientId, encounterId: encId, serviceId: "s", serviceCode: "CONS", name: "Consultation", kind: "consultation", qty: 1,
    unitPrice: toDecimal128(money("250.00")), taxCode: "STD", taxRate: toDecimal128(money("5")), revenueAccountSystem: "rev_consultation",
    status: "unbilled", createdAt: new Date(), createdBy: "x",
  });
  return id;
}
async function bal(code: string) {
  const tb = await trialBalance(fin, {});
  return tb.rows.find((r) => r.code === code)?.balance ?? money(0);
}

beforeAll(async () => {
  await ensureIndexes();
  await ensureChartOfAccounts(ORG);
  const y = new Date().getUTCFullYear();
  for (const year of [y - 1, y, y + 1]) for (let m = 1; m <= 12; m++)
    await tenantCol<any>(ORG, "fiscal_periods").insertOne({ _id: `${ORG}:${year}-${m}`, year, month: m, status: "open", start: new Date(Date.UTC(year, m - 1, 1, -4)), end: new Date(Date.UTC(year, m, 1, -4)) });
  patientId = (await createPatient(reg, { fullName: "Insured Person", dob: "1985-02-02", sex: "male", phone: "+971507770001" }))._id;
  const payer = await createPayer(coord, { name: "Sandbox Insurer", code: "SBI", kind: "insurer" });
  payerId = payer._id;
  const plan = await createPlan(coord, { payerId, name: "Gold", copayPct: 20, copayCapPerVisit: "50.00", preauthServiceCodes: ["CONS"], exclusions: [] });
  planId = plan._id;
  const today = new Date();
  policyId = (await createPolicy(coord, { patientId, planId, memberNo: "M-1001", startDate: new Date(today.getTime() - 86400000 * 30), endDate: new Date(today.getTime() + 86400000 * 300) }))._id;
  await tenantCol<any>(ORG, "encounters").insertOne({ _id: "enc-ins", patientId, doctorId: "d", appointmentId: "a", status: "completed", diagnoses: [{ code: "J06.9", description: "URTI", system: "ICD-10-CM", primary: true }], vitals: [], openedAt: new Date(), openedBy: "x" });
  await tenantCol<any>(ORG, "encounters").insertOne({ _id: "enc-nodx", patientId, doctorId: "d", appointmentId: "b", status: "completed", diagnoses: [], vitals: [], openedAt: new Date(), openedBy: "x" });
});
afterAll(async () => { await closeClient(); });

describe("Scenario B: insured consultation to remittance", () => {
  let claimId = "", invoiceId = "";
  const ar0 = { pat: money(0), ins: money(0) };

  it("blocks invoicing until eligibility is recorded", async () => {
    ar0.pat = await bal("1100"); ar0.ins = await bal("1110");
    await expect(finalizeInsuredInvoice(coord, { patientId, chargeIds: [await seedCharge("enc-ins")], policyId })).rejects.toMatchObject({ code: "VALIDATION" });
    await recordEligibility(coord, { patientId, policyId, result: "eligible", source: "manual", reference: "CALL-77" });
  });

  it("splits copay (20% capped at 50) between patient and payer and posts both receivables", async () => {
    const r = await finalizeInsuredInvoice(coord, { patientId, chargeIds: [await seedCharge("enc-ins")], policyId });
    invoiceId = r.invoice._id; claimId = r.claim._id;
    expect(fromDecimal128(r.invoice.total).toFixed(2)).toBe("262.50");
    expect(fromDecimal128(r.invoice.patientShare).toFixed(2)).toBe("50.00");
    expect(fromDecimal128(r.invoice.payerShare).toFixed(2)).toBe("212.50");
    expect(fromDecimal128(r.invoice.balance).toFixed(2)).toBe("50.00");
    expect((await bal("1100")).minus(ar0.pat).toFixed(2)).toBe("50.00");
    expect((await bal("1110")).minus(ar0.ins).toFixed(2)).toBe("212.50");
    expect(fromDecimal128(r.claim.outstanding).toFixed(2)).toBe("212.50");
    expect(r.claim.items[0].diagnosisCodes).toEqual(["J06.9"]);
  });

  it("patient pays their copay", async () => {
    await recordPayment(reg, { invoiceId, method: "card", amount: "50.00", idempotencyKey: `copay-${invoiceId}` });
  });

  it("validation fails without pre-authorisation, passes after approval", async () => {
    const v1 = await validateClaim(coord, claimId);
    expect(v1.errors.join(" ")).toMatch(/pre-?auth/i);
    const pa = await requestPreauth(coord, { patientId, policyId, serviceCodes: ["CONS"], estimatedAmount: "212.50" });
    await expect(decidePreauth(reg, pa._id, { approved: true, approvedAmount: "212.50", reference: "PA-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await decidePreauth(fin, pa._id, { approved: true, approvedAmount: "212.50", reference: "PA-1" });
    const v2 = await validateClaim(coord, claimId);
    expect(v2.errors).toEqual([]);
    expect(v2.claim.status).toBe("validated");
  });

  it("claim without a diagnosis cannot be validated", async () => {
    const r = await finalizeInsuredInvoice(coord, { patientId, chargeIds: [await seedCharge("enc-nodx")], policyId });
    const v = await validateClaim(coord, r.claim._id);
    expect(v.errors.join(" ")).toMatch(/diagnosis/i);
    await expect(submitClaim(coord, r.claim._id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("submission goes through the SANDBOX adapter; rejection then resubmission works", async () => {
    const sub = await submitClaim(coord, claimId);
    expect(sub.status).toBe("submitted");
    expect(sub.submissions[0].adapter).toBe("sandbox");
    await recordPayerResponse(coord, claimId, { outcome: "rejected", reason: "Missing medical report" });
    await expect(submitClaim(coord, claimId)).rejects.toMatchObject({ code: "CONFLICT" });
    const re = await resubmitClaim(coord, claimId);
    expect(re.status).toBe("draft");
    expect(re.version).toBe(2);
    await validateClaim(coord, claimId);
    await submitClaim(coord, claimId);
    const acc = await recordPayerResponse(coord, claimId, { outcome: "accepted" });
    expect(acc.status).toBe("accepted");
  });

  it("remittance pays 200.00, denies 12.50, is idempotent and finance-only", async () => {
    const bank0 = await bal("1010");
    const input = { payerId, reference: "REM-2026-001", lines: [{ claimId, paid: "200.00", denied: "12.50", reason: "Non-covered item" }] };
    await expect(postRemittance(reg, input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const a = await postRemittance(fin, input);
    const b = await postRemittance(fin, input);
    expect(b._id).toBe(a._id);
    expect((await bal("1010")).minus(bank0).toFixed(2)).toBe("200.00");
    const c = await tenantCol<any>(ORG, "claims").findOne({ _id: claimId });
    expect(c.status).toBe("partially_paid");
    expect(fromDecimal128(c.outstanding).toFixed(2)).toBe("12.50");
    expect(c.denials.at(-1).reason).toBe("Non-covered item");
  });

  it("remittance cannot overpay a claim", async () => {
    await expect(postRemittance(fin, { payerId, reference: "REM-OVER", lines: [{ claimId, paid: "99.00" }] })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("write-off clears the remainder; claims sub-ledger equals GL AR-insurance; books balance", async () => {
    await expect(writeOffClaim(coord, claimId, "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await writeOffClaim(fin, claimId, "Non-covered, patient not billed");
    expect((await tenantCol<any>(ORG, "claims").findOne({ _id: claimId })).status).toBe("written_off");
    const sub = await insuranceReceivables(fin);
    const gl = await bal("1110");
    expect(gl.toFixed(2)).toBe(sub.total.toFixed(2));
    const tb = await trialBalance(fin, {});
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
  });

  it("org isolation on insurance data", async () => {
    await expect(validateClaim(ctxFor(["insurance_coordinator"], "other-org"), claimId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
