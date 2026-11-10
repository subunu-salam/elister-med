import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { toDecimal128, money, fromDecimal128 } from "@/core/money";
import { ctxFor } from "@/test/helpers";
import { ensureChartOfAccounts } from "@/modules/ledger/accounts";
import { trialBalance } from "@/modules/reports/trialBalance";
import { createPatient } from "@/modules/patients/service";
import { createPayer, createPlan, createPolicy, recordEligibility, requestPreauth } from "@/modules/insurance/masters";
import { finalizeInsuredInvoice, validateClaim, submitClaim, getClaim, resubmitClaim } from "@/modules/insurance/claims";
import { startMockDha, type MockDha } from "./mock-server";
import { buildClaimSubmission, parseXml, kid, kids, val } from "./xml";
import { setEclConfig, getEclConfig, testConnection, pollInbox, sendPriorAuth, listEclTransactions, checkEligibilityEcl } from "./service";

const ORG = "org-ecl";
const FAC = "DHA-F-0083721";
const admin = ctxFor(["org_admin"], ORG, "adm", "br1");
const reg = ctxFor(["receptionist"], ORG, "recep", "br1");
const coord = ctxFor(["insurance_coordinator"], ORG, "coord", "br1");
let mock: MockDha;
let patientId = "", policyId = "", payerId = "";

async function seedCharge(code = "CONS", price = "250.00") {
  const id = `ec-${Math.random().toString(36).slice(2)}`;
  await tenantCol<any>(ORG, "charges").insertOne({ _id: id, patientId, encounterId: "enc-ecl", serviceId: "s", serviceCode: code, name: code, kind: "consultation", qty: 1, unitPrice: toDecimal128(money(price)), taxCode: "ZERO", taxRate: toDecimal128(money("0")), revenueAccountSystem: "rev_consultation", doctorId: "ecl-doc-1", status: "unbilled", createdAt: new Date(), createdBy: "x" });
  return id;
}
const bal = async (code: string) => (await trialBalance(admin, {})).rows.find((r) => r.code === code)?.balance ?? money(0);
async function cfg(over: Partial<Parameters<typeof setEclConfig>[1]> = {}) {
  await setEclConfig(admin, { mode: "mock", baseUrl: mock.url, facilityId: FAC, login: "elister_test", password: "Mock-Only-Pass-1", payerMap: { SBI: "DAMAN" }, ...over });
}
async function insuredClaim(code = "CONS", price = "250.00") {
  await recordEligibility(coord, { patientId, policyId, result: "eligible", source: "manual", reference: `E-${Math.random()}` });
  const r = await finalizeInsuredInvoice(coord, { patientId, chargeIds: [await seedCharge(code, price)], policyId });
  await validateClaim(coord, r.claim._id);
  return r.claim;
}

beforeAll(async () => {
  mock = await startMockDha({ authRequired: ["CONS-AUTH"] });
  await ensureIndexes();
  await ensureChartOfAccounts(ORG);
  const y = new Date().getUTCFullYear();
  for (const year of [y - 1, y, y + 1]) for (let m = 1; m <= 12; m++)
    await tenantCol<any>(ORG, "fiscal_periods").insertOne({ _id: `${ORG}:${year}-${m}`, year, month: m, status: "open", start: new Date(Date.UTC(year, m - 1, 1, -4)), end: new Date(Date.UTC(year, m, 1, -4)) });
  patientId = (await createPatient(reg, { fullName: "Ecl Patient", dob: "1985-02-02", sex: "male", phone: "+971507770099", emiratesId: "784-1985-1234567-1" }))._id;
  payerId = (await createPayer(coord, { name: "Daman (mock)", code: "SBI", kind: "insurer" }))._id;
  const planId = (await createPlan(coord, { payerId, name: "Gold", copayPct: 20, copayCapPerVisit: "50.00", preauthServiceCodes: ["CONS-AUTH"], exclusions: [] }))._id;
  const t = new Date();
  policyId = (await createPolicy(coord, { patientId, planId, memberNo: "M-1001", startDate: new Date(t.getTime() - 86400000 * 30), endDate: new Date(t.getTime() + 86400000 * 300) }))._id;
  await tenantCol<any>(ORG, "staff").insertOne({ _id: "ecl-doc-1", userKey: "dr.test", licenceNo: "DHA-PRAC-0001", name: "Dr Test", departmentId: "d", active: true, role: "doctor" });
  await tenantCol<any>(ORG, "encounters").insertOne({ _id: "enc-ecl", patientId, doctorId: "ecl-doc-1", appointmentId: "a", status: "completed", diagnoses: [{ code: "J06.9", description: "URTI", system: "ICD-10-CM", primary: true }], vitals: [], openedAt: new Date(Date.now() - 1800000), completedAt: new Date(Date.now() - 900000), openedBy: "x", branchId: "br1" });
});
afterAll(async () => { await mock.close(); await closeClient(); });

describe("eClaimLink XML", () => {
  it("round-trips a claim and rejects malformed documents", () => {
    const xml = buildClaimSubmission({ sender: FAC, receiver: "DAMAN", at: new Date("2026-03-01T08:00:00Z"), disposition: "TEST" }, [{
      id: "CLM-1", memberId: "M1", payerId: "DAMAN", providerId: FAC, emiratesId: "784-1985-1234567-1", gross: "262.50", patientShare: "50.00", net: "212.50",
      encounter: { facilityId: FAC, type: 1, patientId: "MRN-1", start: new Date("2026-03-01T08:00:00Z"), end: new Date("2026-03-01T08:20:00Z") },
      diagnoses: [{ type: "Principal", code: "J06.9" }], activities: [{ id: "CLM-1-1", start: new Date("2026-03-01T08:00:00Z"), type: 3, code: "99213 & co", quantity: 1, net: "212.50", clinician: "DHA-PRAC-0001" }],
    }]);
    const root = parseXml(xml);
    expect(root.name).toBe("Claim.Submission");
    expect(val(kid(root, "Header"), "TransactionDate")).toBe("01/03/2026 12:00");   // Dubai time
    expect(val(kids(root, "Claim")[0], "Net")).toBe("212.50");
    expect(val(kid(kids(root, "Claim")[0], "Activity"), "Code")).toBe("99213 & co"); // escaping survives
    expect(() => parseXml("<a><b></a>")).toThrow(/Malformed/);
    expect(() => parseXml("<a></a><b/>")).toThrow(/after the root/);
  });
});

describe("configuration and connection", () => {
  it("encrypts the password, never returns it, and validates input", async () => {
    await expect(setEclConfig(admin, { mode: "mock", baseUrl: "ftp://x", facilityId: FAC, login: "l", password: "p" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(setEclConfig(admin, { mode: "production", baseUrl: "http://insecure", facilityId: FAC, login: "l", password: "p" })).rejects.toThrow(/https/);
    await expect(setEclConfig(reg, { mode: "off", baseUrl: "", facilityId: "", login: "" })).rejects.toThrow();
    await cfg();
    const c = await getEclConfig(admin);
    expect(c).toMatchObject({ mode: "mock", hasPassword: true, facilityId: FAC });
    expect(JSON.stringify(c)).not.toContain("Mock-Only-Pass-1");
    const raw = await tenantCol<any>(ORG, "eclaimlink_config").findOne({ key: "main" });
    expect(raw!.passwordEnc).not.toContain("Mock-Only-Pass-1");
  });
  it("tests the connection, and reports bad credentials", async () => {
    expect((await testConnection(admin)).ok).toBe(true);
    await cfg({ password: "wrong" });
    const bad = await testConnection(admin);
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/invalid login/i);
    await cfg();
  });
});

describe("claim to remittance through the mock DHA", () => {
  it("submits through eClaimLink, then polling posts the payment and the claim is paid", async () => {
    mock.scenario("never", "paid");
    const claim = await insuredClaim();
    mock.scenario(claim.number, "paid");
    const before = await bal("1010");
    const sent = await submitClaim(coord, claim._id);
    expect(sent.status).toBe("submitted");
    expect(sent.submissions.at(-1)).toMatchObject({ adapter: "eclaimlink", mode: "sandbox" });
    const out = (await listEclTransactions(admin)).find((t) => t.claimId === claim._id)!;
    expect(out).toMatchObject({ direction: "out", type: "Claim.Submission", status: "accepted" });
    const x = parseXml(out.xml);
    expect(val(kids(x, "Claim")[0], "MemberID")).toBe("M-1001");
    expect(val(kids(x, "Claim")[0], "EmiratesIDNumber")).toBe("784-1985-1234567-1");
    expect(val(kid(kids(x, "Claim")[0], "Activity"), "Clinician")).toBe("DHA-PRAC-0001");
    expect(val(kids(x, "Claim")[0], "Net")).toBe("200.00");          // 250 less 20% copay capped at 50
    const s = await pollInbox(admin);
    expect(s).toMatchObject({ found: 1, remittances: 1, claimsPaid: 1, amountPaid: "200.00" });
    const after = await getClaim(coord, claim._id);
    expect(after.status).toBe("paid");
    expect((await bal("1010")).minus(before).toFixed(2)).toBe("200.00");
    expect((await pollInbox(admin)).found).toBe(0);                  // nothing is applied twice
  });

  it("a fully denied claim comes back rejected with the denial code, and can be corrected and resubmitted", async () => {
    const claim = await insuredClaim("CONS", "300.00");
    mock.scenario(claim.number, "denied");
    await submitClaim(coord, claim._id);
    const s = await pollInbox(admin);
    expect(s.claimsDenied).toBe(1);
    const rej = await getClaim(coord, claim._id);
    expect(rej.status).toBe("rejected");
    expect(rej.denials.at(-1)!.reason).toContain("CODE-010");
    mock.scenario(claim.number, "paid");
    await resubmitClaim(coord, claim._id);
    await validateClaim(coord, claim._id);
    await submitClaim(coord, claim._id);
    const re = (await listEclTransactions(admin)).find((t) => t.claimId === claim._id && t.type === "Claim.Submission");
    expect(kid(kids(parseXml(re!.xml), "Claim")[0], "Resubmission")).toBeTruthy();
    expect((await pollInbox(admin)).claimsPaid).toBe(1);
    expect((await getClaim(coord, claim._id)).status).toBe("paid");
  });

  it("a partly denied claim pays the approved part and keeps the rest outstanding with the reason", async () => {
    const c1 = await seedCharge("CONS", "100.00"), c2 = await seedCharge("PROC", "400.00");
    await recordEligibility(coord, { patientId, policyId, result: "eligible", source: "manual", reference: "E-part" });
    const r = await finalizeInsuredInvoice(coord, { patientId, chargeIds: [c1, c2], policyId });
    await validateClaim(coord, r.claim._id);
    mock.scenario(r.claim.number, "partial");
    await submitClaim(coord, r.claim._id);
    const s = await pollInbox(admin);
    expect(s.claimsPartial).toBe(1);
    const c = await getClaim(coord, r.claim._id);
    expect(c.status).toBe("partially_paid");
    expect(fromDecimal128(c.outstanding).gt(0)).toBe(true);
    expect(c.denials.at(-1)!.reason).toContain("MNEC-003");
  });

  it("the mock rejects bad submissions with a clear error, and the claim stays unsent", async () => {
    const claim = await insuredClaim();
    await cfg({ payerMap: { SBI: "NOT-A-PAYER" } });
    await expect(submitClaim(coord, claim._id)).rejects.toThrow(/not a registered payer|E-RECEIVER|E-PAYER/);
    expect((await getClaim(coord, claim._id)).status).toBe("validated");
    const bad = (await listEclTransactions(admin)).find((t) => t.claimId === claim._id)!;
    expect(bad.status).toBe("rejected");
    await cfg();
    await submitClaim(coord, claim._id);                              // corrected mapping goes through
    mock.scenario(claim.number, "paid");
    await pollInbox(admin);
  });

  it("an unreachable server leaves the claim validated and is logged", async () => {
    const claim = await insuredClaim();
    await cfg({ baseUrl: "http://127.0.0.1:9" });
    await expect(submitClaim(coord, claim._id)).rejects.toThrow(/unreachable/);
    expect((await getClaim(coord, claim._id)).status).toBe("validated");
    await cfg();
    mock.scenario(claim.number, "paid");
    await submitClaim(coord, claim._id);
    await pollInbox(admin);
  });
});

describe("prior authorisation and eligibility", () => {
  it("sends the request, applies the approval, and the claim carries the authorisation number", async () => {
    const pa = await requestPreauth(coord, { patientId, policyId, serviceCodes: ["CONS-AUTH"], estimatedAmount: "250.00" });
    await sendPriorAuth(coord, pa._id);
    const s = await pollInbox(admin);
    expect(s.authApproved).toBe(1);
    const row = await tenantCol<any>(ORG, "preauths").findOne({ _id: pa._id });
    expect(row!.status).toBe("approved");
    expect(row!.reference).toMatch(/^AUTH-DAMAN-/);
    const claim = await insuredClaim("CONS-AUTH", "250.00");
    mock.scenario(claim.number, "paid");
    await submitClaim(coord, claim._id);
    const out = (await listEclTransactions(admin)).find((t) => t.claimId === claim._id)!;
    expect(val(kid(kids(parseXml(out.xml), "Claim")[0], "Activity"), "PriorAuthorizationID")).toBe(row!.reference);
    expect((await pollInbox(admin)).claimsPaid).toBe(1);             // the mock pays it: authorisation was on file
  });
  it("a refused authorisation is recorded as rejected", async () => {
    const pa = await requestPreauth(coord, { patientId, policyId, serviceCodes: ["AES-BOTOX"], estimatedAmount: "1200.00" });
    await sendPriorAuth(coord, pa._id);
    expect((await pollInbox(admin)).authRefused).toBe(1);
    expect((await tenantCol<any>(ORG, "preauths").findOne({ _id: pa._id }))!.status).toBe("rejected");
  });
  it("checks eligibility against the payer and records the result", async () => {
    const r = await checkEligibilityEcl(coord, policyId);
    expect(r.eligible).toBe(true);
    const rows = await tenantCol<any>(ORG, "eligibility_checks").find({ policyId, source: "eclaimlink" });
    expect(rows.length).toBe(1);
  });
  it("only authorised roles can poll or change the connection", async () => {
    await expect(pollInbox(reg)).rejects.toThrow();
    await expect(testConnection(coord)).rejects.toThrow();
  });
});
