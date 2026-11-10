import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { money, toDecimal128 } from "@/core/money";
import { ctxFor } from "@/test/helpers";
import { ensureChartOfAccounts } from "@/modules/ledger/accounts";
import { createPatient } from "@/modules/patients/service";
import { finalizeInvoice, issueCreditNote } from "@/modules/billing/invoice";
import { addAttachment, listAttachments, getAttachment } from "@/core/attachments";
import {
  buildAdtA04, buildFhirPatient, validateDemographics, enqueueHieMessage, processHieQueue, interfaceMonitor, listErrorQueue, retryDead, matchPatient, setCodeMap, mapCode, sandboxHie,
} from "./hie";
import { buildEInvoice, submitEInvoice, eInvoiceStatus, validateEInvoice } from "./einvoice";
import {
  addLicence, expiringItems, addChecklistItem, setChecklistStatus, reportIncident, addCorrectiveAction, completeCorrectiveAction, closeIncident, publishPolicy, acknowledgePolicy,
  policyStatus, integrationMatrix, setIntegrationStatus, auditReport, complianceDashboard, accessReviewReport, completeAccessReview,
} from "@/modules/compliance/service";

const ORG = "org-int";
const admin = ctxFor(["org_admin"], ORG, "adm1", "br1");
const reg = ctxFor(["receptionist"], ORG, "recep", "br1");
const md = ctxFor(["medical_director"], ORG, "md1", "br1");
const md2 = ctxFor(["medical_director"], ORG, "md2", "br1");
const doctor = ctxFor(["doctor"], ORG, "doc1", "br1");
const auditor = ctxFor(["auditor"], ORG, "aud1", "br1");
let pid = "", invoiceId = "";

beforeAll(async () => {
  await ensureIndexes();
  await ensureChartOfAccounts(ORG);
  const y = new Date().getUTCFullYear();
  for (const year of [y - 1, y, y + 1]) for (let m = 1; m <= 12; m++)
    await tenantCol<any>(ORG, "fiscal_periods").insertOne({ _id: `${ORG}:${year}-${m}`, year, month: m, status: "open", start: new Date(Date.UTC(year, m - 1, 1, -4)), end: new Date(Date.UTC(year, m, 1, -4)) });
  await tenantCol<any>(ORG, "tax_codes").insertOne({ _id: `${ORG}:t`, code: "STD", rate: toDecimal128(money("5")), kind: "standard", reviewRequired: true });
  await tenantCol<any>(ORG, "orgs").insertOne({ _id: ORG, name: "Sandbox Clinic", trn: "100000000000003", modules: {}, currency: "AED", timezone: "Asia/Dubai" });
  pid = (await createPatient(reg, { fullName: "Hie Patient", dob: "1991-07-07", sex: "female", phone: "+971502220001" }))._id;
  await tenantCol<any>(ORG, "charges").insertOne({ _id: "ch-e1", patientId: pid, encounterId: "e", serviceId: "s", serviceCode: "CONS", name: "Consultation", kind: "consultation", qty: 1, unitPrice: toDecimal128(money("200.00")), taxCode: "STD", taxRate: toDecimal128(money("5")), revenueAccountSystem: "rev_consultation", status: "unbilled", createdAt: new Date(), createdBy: "x" });
  invoiceId = (await finalizeInvoice(reg, { patientId: pid, chargeIds: ["ch-e1"] }))._id;
});
afterAll(async () => { await closeClient(); });

describe("HIE adapters (sandbox only)", () => {
  it("builds well-formed HL7 v2 ADT^A04 and FHIR Patient messages and validates demographics", async () => {
    const p = { mrn: "MRN-000001", fullName: "Layla Mohammed Al Test", dob: "1991-07-07", sex: "female", phone: "+971502220001" };
    const raw = buildAdtA04(p, { sendingFacility: "Sandbox Clinic", receivingFacility: "NABIDH", controlId: "CTRL1", at: new Date("2026-01-01T10:00:00Z") });
    const segs = raw.split("\r");
    expect(segs.map((s) => s.slice(0, 3))).toEqual(["MSH", "EVN", "PID", "PV1"]);
    expect(segs[0]).toContain("ADT^A04");
    expect(segs[2]).toContain("MRN-000001^^^HEALTHOS^MR");
    expect(segs[2]).toContain("19910707|F");
    expect(buildFhirPatient(p)).toMatchObject({ resourceType: "Patient", gender: "female", birthDate: "1991-07-07" });
    expect(validateDemographics({ mrn: "x", fullName: "Single", dob: "bad", sex: "?" })).toHaveLength(3);
    expect(buildAdtA04({ ...p, fullName: "A|B^C Test" }, { sendingFacility: "S", receivingFacility: "R", controlId: "1" })).not.toContain("A|B"); // delimiter injection neutralised
  });

  it("queue: acknowledged on success; rejected messages retry then reach the error queue; manual retry", async () => {
    const ok = await enqueueHieMessage(admin, { hie: "NABIDH", patientId: pid, type: "ADT_A04" });
    const bad = await createPatient(reg, { fullName: "REJECT Case", dob: "1990-01-01", sex: "male", phone: "+971502220002" });
    const rej = await enqueueHieMessage(admin, { hie: "MALAFFI", patientId: bad._id, type: "FHIR_PATIENT" });
    const r1 = await processHieQueue(admin);
    expect(r1).toEqual({ acknowledged: 1, failed: 1, dead: 0 });
    await processHieQueue(admin);
    const r3 = await processHieQueue(admin);
    expect(r3.dead).toBe(1);
    expect((await listErrorQueue(admin)).map((m) => m._id)).toEqual([rej._id]);
    expect((await interfaceMonitor(admin))).toMatchObject({ acknowledged: 1, errorQueue: 1, mode: "sandbox" });
    await retryDead(admin, rej._id);
    expect((await interfaceMonitor(admin)).pending).toBe(1);
    expect(ok.mode).toBe("sandbox");
    expect((await tenantCol<any>(ORG, "hie_messages").findOne({ _id: ok._id })).ack.text).toMatch(/nothing was transmitted/);
    expect(sandboxHie("RIAYATI").mode).toBe("sandbox");
  });

  it("identity matching is transparent; code maps are configuration; roles are enforced", async () => {
    const m = await matchPatient(admin, { fullName: "Hie Patient", dob: "1991-07-07", phone: "+971502220001" });
    expect(m[0]).toMatchObject({ patientId: pid, decision: "match" });
    expect(m[0].why).toEqual(expect.arrayContaining(["exact name", "date of birth"]));
    await setCodeMap(admin, { system: "local-dx", localCode: "URTI", standardCode: "J06.9", standardSystem: "ICD-10-CM" });
    expect(await mapCode(admin, "local-dx", "URTI")).toEqual({ standardCode: "J06.9", standardSystem: "ICD-10-CM" });
    await expect(enqueueHieMessage(doctor, { hie: "NABIDH", patientId: pid, type: "ADT_A04" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("structured e-invoice (sandbox ASP)", () => {
  it("builds a validated structured document with VAT breakdown", async () => {
    const { invoice, errors } = await buildEInvoice(admin, invoiceId);
    expect(errors).toEqual([]);
    expect(invoice).toMatchObject({ specVersion: "internal-0.1", documentType: "380", seller: { trn: "100000000000003" }, totals: { net: "200.00", tax: "10.00", gross: "210.00" } });
    expect(invoice.taxTotals).toEqual([{ category: "S", rate: "5.00", taxable: "200.00", tax: "10.00" }]);
  });

  it("validation catches inconsistent or incomplete documents and blocks submission", async () => {
    const { invoice } = await buildEInvoice(admin, invoiceId);
    expect(validateEInvoice({ ...invoice, seller: { name: "x", trn: "123" } })).toEqual(expect.arrayContaining([expect.stringMatching(/TRN/)]));
    expect(validateEInvoice({ ...invoice, totals: { ...invoice.totals, gross: "999.00" } }).join()).toMatch(/Gross/);
    expect(validateEInvoice({ ...invoice, documentType: "381" }).join()).toMatch(/reference the original/);
  });

  it("submission is tracked, never repeated once accepted, and the credit note links to the invoice", async () => {
    const s = await submitEInvoice(admin, { invoiceId });
    expect(s).toMatchObject({ status: "accepted", mode: "sandbox", adapter: "sandbox-asp", version: 1 });
    await expect(submitEInvoice(admin, { invoiceId })).rejects.toMatchObject({ code: "CONFLICT" });
    const cn = await issueCreditNote(ctxFor(["accountant"], ORG, "acc1", "br1"), { invoiceId, reason: "billed in error" });
    const c = await submitEInvoice(admin, { invoiceId, creditNoteId: cn._id });
    expect(c.payload).toMatchObject({ documentType: "381", precedingInvoice: s.payload.number });
    const status = await eInvoiceStatus(admin);
    expect(status.map((x) => x.number).sort()).toEqual([s.payload.number, cn.number].sort());
  });

  it("an organisation without a TRN gets a rejection record, not a transmission", async () => {
    const O2 = "org-int-notrn", r2 = ctxFor(["receptionist"], O2, "r", "b"), a2 = ctxFor(["org_admin"], O2, "a", "b");
    await ensureChartOfAccounts(O2);
    const y = new Date().getUTCFullYear();
    for (let m = 1; m <= 12; m++) await tenantCol<any>(O2, "fiscal_periods").insertOne({ _id: `${O2}:${y}-${m}`, year: y, month: m, status: "open", start: new Date(Date.UTC(y, m - 1, 1, -4)), end: new Date(Date.UTC(y, m, 1, -4)) });
    await tenantCol<any>(O2, "tax_codes").insertOne({ _id: `${O2}:t`, code: "STD", rate: toDecimal128(money("5")), kind: "standard", reviewRequired: true });
    await tenantCol<any>(O2, "orgs").insertOne({ _id: O2, name: "No TRN Clinic", modules: {} });
    const p = (await createPatient(r2, { fullName: "No Trn Patient", dob: "1990-01-01", sex: "male", phone: "+971502220077" }))._id;
    await tenantCol<any>(O2, "charges").insertOne({ _id: "ch-n", patientId: p, encounterId: "e", serviceId: "s", serviceCode: "C", name: "C", kind: "consultation", qty: 1, unitPrice: toDecimal128(money("10.00")), taxCode: "STD", taxRate: toDecimal128(money("5")), revenueAccountSystem: "rev_consultation", status: "unbilled", createdAt: new Date(), createdBy: "x" });
    const inv = await finalizeInvoice(r2, { patientId: p, chargeIds: ["ch-n"] });
    const s = await submitEInvoice(a2, { invoiceId: inv._id });
    expect(s.status).toBe("rejected");
    expect(s.reference).toBe("");
    expect(s.errors.join()).toMatch(/TRN/);
  });
});

describe("compliance", () => {
  it("licences and staff documents expire in one list; checklist needs evidence; attachments are tenant-scoped, typed and audited", async () => {
    await addLicence(md, { kind: "facility", holder: "Sandbox Clinic", authority: "DHA", number: "FAC-1", expiry: new Date(Date.now() + 20 * 86400000) });
    await addLicence(md, { kind: "practitioner", holder: "Dr Test", authority: "DHA", number: "PR-9", expiry: new Date(Date.now() - 86400000) });
    const e = await expiringItems(md, 60);
    expect(e.map((x) => x.expired)).toEqual([true, false]);
    const item = await addChecklistItem(md, { title: "Fire safety certificate on file", authority: "Civil Defence" });
    await expect(setChecklistStatus(md, item._id, "compliant")).rejects.toMatchObject({ code: "VALIDATION" });
    const att = await addAttachment(md, { resourceType: "compliance", resourceId: item._id, filename: "cert.pdf", contentType: "application/pdf", base64: Buffer.from("%PDF-1.4 test").toString("base64") });
    expect(att.sha256).toHaveLength(64);
    await setChecklistStatus(md, item._id, "compliant", att._id);
    await expect(addAttachment(md, { resourceType: "compliance", resourceId: item._id, filename: "x.exe", contentType: "application/x-msdownload", base64: "AAAA" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(addAttachment(reg, { resourceType: "compliance", resourceId: item._id, filename: "x.pdf", contentType: "application/pdf", base64: "AAAA" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await listAttachments(md, "compliance", item._id))).toHaveLength(1);
    expect((await getAttachment(md, att._id)).content.toString()).toBe("%PDF-1.4 test");
    await expect(getAttachment(ctxFor(["medical_director"], "other-org", "x"), att._id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getAttachment(reg, att._id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("incidents: corrective actions must be done; high severity needs a second closer", async () => {
    const i = await reportIncident(md, { title: "Cold chain breach", severity: "high", description: "Fridge temperature out of range for 3 hours" });
    await expect(closeIncident(md2, i._id, "done")).rejects.toMatchObject({ code: "CONFLICT" }); // no corrective action yet
    await addCorrectiveAction(md, i._id, { description: "Replace thermostat", owner: "facilities", due: new Date(Date.now() + 7 * 86400000) });
    await expect(closeIncident(md2, i._id, "done")).rejects.toMatchObject({ code: "CONFLICT" }); // action open
    await completeCorrectiveAction(md, i._id, (await tenantCol<any>(ORG, "incidents").findOne({ _id: i._id })).actions[0]._id);
    await expect(closeIncident(md, i._id, "closing myself")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await closeIncident(md2, i._id, "Thermostat replaced; stock quarantined and discarded");
  });

  it("policy acknowledgement and access review/attestation", async () => {
    const p = await publishPolicy(md, { title: "Data protection policy", body: "All staff must protect patient information." });
    await acknowledgePolicy(doctor2(), p._id);
    await acknowledgePolicy(doctor2(), p._id);
    expect((await policyStatus(md))[0]).toMatchObject({ acknowledgedBy: 1, mine: false });
    const rep = await accessReviewReport(auditor, [{ userId: "doc1", roles: ["doctor"], active: true }, { userId: "ghost", roles: ["nurse"], active: true }]);
    expect(rep.find((r) => r.userId === "ghost")!.flag).toMatch(/no activity/);
    await completeAccessReview(md, "Reviewed all roles; removed none");
    await expect(completeAccessReview(md, " ")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("readiness matrix: no jumping stages, evidence needed for approval, nothing is live by default", async () => {
    const m0 = await integrationMatrix(md);
    expect(m0.every((r) => r.status !== "production_connected")).toBe(true);
    expect(m0.find((r) => r.key === "dha_eclaimlink")!.status).toBe("not_configured");
    await expect(setIntegrationStatus(md, "dha_eclaimlink", "approved", "claimed")).rejects.toMatchObject({ code: "CONFLICT" });
    await setIntegrationStatus(md, "dha_eclaimlink", "specification_reviewed");
    await expect(setIntegrationStatus(md, "nabidh", "sandbox_tested")).resolves.toBeUndefined();
    await expect(setIntegrationStatus(md, "nabidh", "certification_pending")).resolves.toBeUndefined();
    await expect(setIntegrationStatus(md, "nabidh", "approved")).rejects.toMatchObject({ code: "VALIDATION" }); // evidence required
    await setIntegrationStatus(md, "nabidh", "approved", "Regulator letter ref NAB-TEST-001");
    const dash = await complianceDashboard(md);
    expect(dash.integrationsLive).toBe(0);
    expect(dash.expired).toBeGreaterThanOrEqual(1);
  });

  it("audit report needs audit:audit", async () => {
    const rep = await auditReport(auditor, { from: new Date(Date.now() - 86400000), to: new Date(Date.now() + 86400000) });
    expect(rep.total).toBeGreaterThan(0);
    await expect(auditReport(reg, { from: new Date(0), to: new Date() })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

function doctor2() { return ctxFor(["doctor"], ORG, "doc-ack", "br1"); }
