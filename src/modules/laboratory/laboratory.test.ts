import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { money, toDecimal128 } from "@/core/money";
import { ctxFor } from "@/test/helpers";
import { listMyNotifications } from "@/core/notify";
import { createPatient } from "@/modules/patients/service";
import { listUnbilledCharges } from "@/modules/billing/charges";
import {
  createLabTest, approveRanges, orderLab, collectSample, receiveSample, startProcessing, enterResult, verifyResults, releaseOrder, getOrder,
  acknowledgeCritical, listOpenCritical, workQueue, labDashboard, referToExternalLab,
} from "./service";
import { orderImaging, scheduleImaging, markPerformed, writeReport, releaseReport, getImaging } from "@/modules/radiology/service";

const ORG = "org-lab";
const reg = ctxFor(["receptionist"], ORG, "recep", "br1");
const doctor = ctxFor(["doctor"], ORG, "doc1", "br1");
const tech1 = ctxFor(["lab_technician"], ORG, "tech1", "br1");
const tech2 = ctxFor(["lab_technician"], ORG, "tech2", "br1");
const director = ctxFor(["medical_director"], ORG, "dir1", "br1");
const rad1 = ctxFor(["radiologist"], ORG, "rad1", "br1");
const rad2 = ctxFor(["radiologist"], ORG, "rad2", "br1");
let patientId = "", hgb = "", glu = "";

beforeAll(async () => {
  await ensureIndexes();
  await tenantCol<any>(ORG, "tax_codes").insertOne({ _id: `${ORG}:t`, code: "STD", rate: toDecimal128(money("5")), kind: "standard", reviewRequired: true });
  await tenantCol<any>(ORG, "services").insertOne({ _id: "svc-hgb", code: "LAB-HGB", name: "Haemoglobin", kind: "lab", price: toDecimal128(money("45.00")), taxCode: "STD", revenueAccountSystem: "rev_laboratory", departmentId: "LAB", active: true });
  await tenantCol<any>(ORG, "services").insertOne({ _id: "svc-xr", code: "RAD-CXR", name: "Chest X-ray", kind: "radiology", price: toDecimal128(money("120.00")), taxCode: "STD", revenueAccountSystem: "rev_procedure", departmentId: "RAD", active: true });
  await tenantCol<any>(ORG, "staff").insertOne({ _id: "doc-staff", userKey: "d", userId: "doc1", name: "Dr Lab", workDays: [1], workStart: "09:00", workEnd: "17:00", slotMinutes: 20, branchId: "br1", active: true });
  patientId = (await createPatient(reg, { fullName: "Lab Patient", dob: "1985-01-01", sex: "male", phone: "+971506660001" }))._id;
  await tenantCol<any>(ORG, "encounters").insertOne({ _id: "enc-lab", patientId, doctorId: "doc-staff", branchId: "br1", appointmentId: "a", status: "open", diagnoses: [], vitals: [], openedAt: new Date(), openedBy: "x" });
  hgb = (await createLabTest(tech1, { code: "HGB", name: "Haemoglobin", loinc: "718-7", specimen: "Whole blood", unit: "g/dL", serviceId: "svc-hgb", ranges: [{ sex: "male", low: 13.5, high: 17.5, criticalLow: 7, criticalHigh: 20 }, { sex: "female", low: 12, high: 15.5, criticalLow: 7, criticalHigh: 20 }] }))._id;
  glu = (await createLabTest(tech1, { code: "GLU", name: "Glucose", specimen: "Serum", unit: "mmol/L", ranges: [{ low: 3.9, high: 5.6 }] }))._id;
});
afterAll(async () => { await closeClient(); });

describe("Scenario C: laboratory order to released results", () => {
  let orderId = "", alertId = "";

  it("range configuration is validated and has no defaults; flags stay 'range_unreviewed' until a director approves", async () => {
    await expect(createLabTest(tech1, { code: "BAD", name: "Bad test", specimen: "x", unit: "u", ranges: [{ low: 10, high: 5 }] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createLabTest(tech1, { code: "BAD2", name: "Bad crit", specimen: "x", unit: "u", ranges: [{ low: 5, high: 10, criticalLow: 6 }] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(approveRanges(doctor, hgb)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("doctor orders; lab work queue shows it; sample collection assigns a barcode and walks the stages in order", async () => {
    const o = await orderLab(doctor, { encounterId: "enc-lab", testIds: [hgb, glu], priority: "urgent" });
    orderId = o._id;
    expect((await workQueue(tech1)).map((x) => x._id)).toContain(orderId);
    await expect(startProcessing(tech1, orderId)).rejects.toMatchObject({ code: "CONFLICT" });
    const c = await collectSample(tech1, orderId);
    expect(c.barcode).toMatch(/^LAB\d{8}$/);
    await expect(collectSample(tech1, orderId)).rejects.toMatchObject({ code: "CONFLICT" });
    await receiveSample(tech1, orderId);
    await startProcessing(tech1, orderId);
  });

  it("an unapproved range yields range_unreviewed (no clinical flag is invented)", async () => {
    expect((await enterResult(tech1, { orderId, testId: glu, value: 9.9 })).flag).toBe("range_unreviewed");
    await approveRanges(director, hgb);
  });

  it("a critical value raises an alert and notifies the ordering doctor; bad values are rejected", async () => {
    await expect(enterResult(tech1, { orderId, testId: hgb, value: Number.NaN })).rejects.toMatchObject({ code: "VALIDATION" });
    const r = await enterResult(tech1, { orderId, testId: hgb, value: 5.5 });
    expect(r.flag).toBe("critical_low");
    const open = await listOpenCritical(doctor);
    expect(open).toHaveLength(1);
    alertId = open[0]._id;
    const notes = await listMyNotifications(doctor);
    expect(notes.some((n) => n.type === "lab.critical" && n.severity === "critical")).toBe(true);
  });

  it("results stay hidden from the doctor until release; verifier must differ from the person who entered", async () => {
    const hidden = await getOrder(doctor, orderId);
    expect(hidden.resultsHidden).toBe(true);
    expect(hidden.tests.every((t) => t.value === undefined)).toBe(true);
    await expect(verifyResults(tech1, orderId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await verifyResults(tech2, orderId);
    await expect(enterResult(tech2, { orderId, testId: hgb, value: 14 })).rejects.toMatchObject({ code: "CONFLICT" }); // verified results are frozen
  });

  it("release is blocked until the critical alert is acknowledged with a documented action", async () => {
    await expect(releaseOrder(tech2, orderId)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(acknowledgeCritical(tech1, alertId, "called patient")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(acknowledgeCritical(doctor, alertId, " ")).rejects.toMatchObject({ code: "VALIDATION" });
    await acknowledgeCritical(doctor, alertId, "Patient called in for urgent review");
    await releaseOrder(tech2, orderId);
  });

  it("after release: doctor sees values and flags, is notified, and a charge exists exactly once", async () => {
    const o = await getOrder(doctor, orderId);
    expect(o.resultsHidden).toBe(false);
    expect(o.tests.find((t) => t.code === "HGB")!.value).toBe(5.5);
    expect((await listMyNotifications(doctor)).some((n) => n.type === "lab.released")).toBe(true);
    const charges = (await listUnbilledCharges(reg, patientId)).filter((c) => c.serviceCode === "LAB-HGB");
    expect(charges).toHaveLength(1); // GLU has no billable service configured; HGB billed once
    await expect(releaseOrder(tech2, orderId)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await listUnbilledCharges(reg, patientId)).filter((c) => c.serviceCode === "LAB-HGB")).toHaveLength(1);
  });

  it("a normal result is flagged normal; external-lab referral is supported", async () => {
    const o = await orderLab(doctor, { encounterId: "enc-lab", testIds: [hgb] });
    await collectSample(tech1, o._id);
    await expect(referToExternalLab(tech1, o._id, " ")).rejects.toMatchObject({ code: "VALIDATION" });
    await referToExternalLab(tech1, o._id, "Partner Reference Lab (sandbox)");
    expect((await enterResult(tech1, { orderId: o._id, testId: hgb, value: 15 })).flag).toBe("normal");
  });

  it("dashboard numbers are real; org isolation holds", async () => {
    const d = await labDashboard(tech1);
    expect(d.released).toBe(1);
    expect(d.avgTurnaroundMinutes).toBeGreaterThanOrEqual(0);
    await expect(getOrder(ctxFor(["doctor"], "other-org", "x"), orderId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("Radiology workflow", () => {
  it("order -> schedule -> perform -> report -> second-radiologist release -> charge + notification", async () => {
    const o = await orderImaging(doctor, { encounterId: "enc-lab", modality: "XR", study: "Chest PA", serviceId: "svc-xr" });
    await expect(scheduleImaging(rad1, o._id, new Date(Date.now() - 86400000 * 3))).rejects.toMatchObject({ code: "VALIDATION" });
    await scheduleImaging(rad1, o._id, new Date(Date.now() + 3600_000));
    await markPerformed(rad1, o._id, "PACS-REF-123");
    await writeReport(rad1, o._id, { findings: "Lungs clear.", impression: "No acute abnormality." });
    expect((await getImaging(doctor, o._id)).reportHidden).toBe(true);
    await expect(releaseReport(rad1, o._id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await releaseReport(rad2, o._id);
    const g = await getImaging(doctor, o._id);
    expect(g.reportHidden).toBe(false);
    expect(g.report?.impression).toMatch(/No acute/);
    expect((await listUnbilledCharges(reg, patientId)).filter((c) => c.serviceCode === "RAD-CXR")).toHaveLength(1);
    expect((await listMyNotifications(doctor)).some((n) => n.type === "rad.released")).toBe(true);
  });
});
