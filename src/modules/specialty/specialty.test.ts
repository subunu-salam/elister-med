import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol, withTransaction } from "@/core/db";
import { money, toDecimal128, fromDecimal128 } from "@/core/money";
import { ctxFor } from "@/test/helpers";
import { ensureChartOfAccounts } from "@/modules/ledger/accounts";
import { trialBalance } from "@/modules/reports/trialBalance";
import { createPatient } from "@/modules/patients/service";
import { createItem, receiveIntoStock, stockOnHand } from "@/modules/inventory/service";
import { listUnbilledCharges } from "@/modules/billing/charges";
import { listDueFollowUps } from "@/modules/crm/service";
import {
  upsertSpecialtyTemplate, listSpecialtyTemplates, saveEncounterForm, recordTooth, getDentalChart, createTreatmentPlan, completePlanItem, isValidFdi, sellPackage, consumeSession,
  recordMeasurement, measurementTrend, logPhysioSession, setCarePlan, generateCareReminders, completeCareVisit, recordGrowth, listGrowth, recordVaccination, guardianCheck,
  recordDermProcedure, linkProcedurePhoto, grantPhotoConsent, recordProductUsage,
} from "./service";

const ORG = "org-spec";
const doctor = ctxFor(["doctor"], ORG, "doc1", "br1");
const reg = ctxFor(["receptionist"], ORG, "recep", "br1");
const md = ctxFor(["medical_director"], ORG, "md1", "br1");
const im = ctxFor(["inventory_manager"], ORG, "im1", "br1");
const fin = ctxFor(["finance_manager"], ORG, "fin1", "br1");
let adult = "", child = "";

beforeAll(async () => {
  await ensureIndexes();
  await ensureChartOfAccounts(ORG);
  const y = new Date().getUTCFullYear();
  for (const year of [y - 1, y, y + 1]) for (let m = 1; m <= 12; m++)
    await tenantCol<any>(ORG, "fiscal_periods").insertOne({ _id: `${ORG}:${year}-${m}`, year, month: m, status: "open", start: new Date(Date.UTC(year, m - 1, 1, -4)), end: new Date(Date.UTC(year, m, 1, -4)) });
  await tenantCol<any>(ORG, "tax_codes").insertOne({ _id: `${ORG}:t`, code: "STD", rate: toDecimal128(money("5")), kind: "standard", reviewRequired: true });
  for (const [id, price] of [["svc-scale", "400.00"], ["svc-fill", "300.00"]] as const)
    await tenantCol<any>(ORG, "services").insertOne({ _id: id, code: id, name: id === "svc-scale" ? "Scaling" : "Filling", kind: "procedure", price: toDecimal128(money(price)), taxCode: "STD", revenueAccountSystem: "rev_dental", departmentId: "DENT", active: true });
  adult = (await createPatient(reg, { fullName: "Dental Dan", dob: "1985-05-05", sex: "male", phone: "+971503330001" }))._id;
  child = (await createPatient(reg, { fullName: "Little Lina", dob: "2023-03-03", sex: "female", phone: "+971503330002" }))._id;
});
afterAll(async () => { await closeClient(); });

describe("template framework", () => {
  it("versioned templates validate structured forms; forms are append-only per encounter", async () => {
    await expect(upsertSpecialtyTemplate(reg, { key: "k", name: "n", specialty: "s", sections: [{ id: "a", label: "A", fields: [] }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await upsertSpecialtyTemplate(doctor, { key: "derm-intake", name: "Dermatology intake", specialty: "dermatology", sections: [{ id: "h", label: "History", fields: [{ id: "duration", label: "Duration (weeks)", type: "number", required: true }, { id: "site", label: "Site", type: "choice", options: ["face", "trunk", "limbs"] }] }] });
    const t2 = await upsertSpecialtyTemplate(doctor, { key: "derm-intake", name: "Dermatology intake v2", specialty: "dermatology", sections: [{ id: "h", label: "History", fields: [{ id: "duration", label: "Duration (weeks)", type: "number", required: true }, { id: "site", label: "Site", type: "choice", options: ["face", "trunk", "limbs"] }] }] });
    expect(t2.version).toBe(2);
    expect((await listSpecialtyTemplates(doctor)).filter((t) => t.key === "derm-intake")).toHaveLength(1);
    await expect(saveEncounterForm(doctor, { encounterId: "e1", templateKey: "derm-intake", data: { site: "face" } })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(saveEncounterForm(doctor, { encounterId: "e1", templateKey: "derm-intake", data: { duration: 3, site: "tail" } })).rejects.toMatchObject({ code: "VALIDATION" });
    const f1 = await saveEncounterForm(doctor, { encounterId: "e1", templateKey: "derm-intake", data: { duration: 3, site: "face" } });
    const f2 = await saveEncounterForm(doctor, { encounterId: "e1", templateKey: "derm-intake", data: { duration: 4, site: "face" } });
    expect([f1.version, f2.version]).toEqual([1, 2]);
  });
});

describe("dental", () => {
  it("validates FDI numbering (permanent and deciduous) and keeps the chart history", async () => {
    expect(isValidFdi(18) && isValidFdi(48) && isValidFdi(55) && isValidFdi(85)).toBe(true);
    expect(isValidFdi(19) || isValidFdi(56) || isValidFdi(9)).toBe(false);
    await expect(recordTooth(doctor, { patientId: adult, tooth: 19, condition: "caries" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(recordTooth(doctor, { patientId: adult, tooth: 16, surface: "X", condition: "caries" })).rejects.toMatchObject({ code: "VALIDATION" });
    await recordTooth(doctor, { patientId: adult, tooth: 16, surface: "O", condition: "caries" });
    await recordTooth(doctor, { patientId: adult, tooth: 16, surface: "O", condition: "filled" });
    const chart = await getDentalChart(doctor, adult);
    expect(chart.entries.find((e) => e.tooth === 16)!.condition).toBe("filled");
    expect(chart.history).toHaveLength(2);
  });

  it("multi-visit plan: estimate from the catalogue, each item bills once, plan completes when all are done", async () => {
    const plan = await createTreatmentPlan(doctor, { patientId: adult, items: [{ tooth: 16, serviceId: "svc-fill" }, { tooth: 26, serviceId: "svc-scale" }] });
    expect(fromDecimal128(plan.estimate).toFixed(2)).toBe("700.00");
    await completePlanItem(doctor, plan._id, 0, "enc-d1");
    await expect(completePlanItem(doctor, plan._id, 0, "enc-d1")).rejects.toMatchObject({ code: "CONFLICT" });
    const mid = await tenantCol<any>(ORG, "treatment_plans").findOne({ _id: plan._id });
    expect(mid.status).toBe("active");
    const done = await completePlanItem(doctor, plan._id, 1, "enc-d2");
    expect(done.status).toBe("completed");
    expect((await listUnbilledCharges(reg, adult)).filter((c) => c.serviceCode.startsWith("svc-"))).toHaveLength(2);
    await expect(createTreatmentPlan(doctor, { patientId: adult, items: [{ tooth: 99, serviceId: "svc-fill" }] })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("packages, physio and chronic care", () => {
  it("package balance never goes negative, even under concurrent use", async () => {
    const pkg = await sellPackage(reg, { patientId: adult, name: "Physio x3", sessions: 3, price: "600.00" });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => consumeSession(doctor, pkg._id, "session")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const row = await tenantCol<any>(ORG, "packages").findOne({ _id: pkg._id });
    expect(row.used).toBe(3);
    expect(row.status).toBe("exhausted");
    await expect(consumeSession(doctor, pkg._id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("physio sessions consume the package only when attended; measurement trends compute deltas", async () => {
    const pkg = await sellPackage(reg, { patientId: adult, name: "Physio x2", sessions: 2, price: "400.00" });
    await logPhysioSession(doctor, { patientId: adult, packageId: pkg._id, attendance: "missed", exercises: [] });
    await logPhysioSession(doctor, { patientId: adult, packageId: pkg._id, attendance: "attended", exercises: ["shoulder pendulum"] });
    expect((await tenantCol<any>(ORG, "packages").findOne({ _id: pkg._id })).used).toBe(1);
    await recordMeasurement(doctor, { patientId: adult, kind: "pain_score", value: 8, unit: "/10", at: new Date("2026-01-01") });
    await recordMeasurement(doctor, { patientId: adult, kind: "pain_score", value: 5, unit: "/10", at: new Date("2026-02-01") });
    expect(await measurementTrend(doctor, adult, "pain_score")).toMatchObject({ delta: -3, direction: "down" });
    await expect(recordMeasurement(doctor, { patientId: adult, kind: "x", value: Number.NaN, unit: "u" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("care plans generate CRM follow-ups once per due date and reschedule after the visit", async () => {
    const plan = await setCarePlan(doctor, { patientId: adult, condition: "Type 2 diabetes", intervalDays: 90, kinds: ["hba1c"] });
    await tenantCol<any>(ORG, "care_plans").updateOne({ _id: plan._id }, { $set: { nextDue: new Date(Date.now() - 86400000) } });
    expect(await generateCareReminders(reg)).toBeGreaterThanOrEqual(1);
    await generateCareReminders(reg);
    expect((await listDueFollowUps(reg)).filter((f) => f.kind === "chronic_care")).toHaveLength(1);
    await completeCareVisit(doctor, plan._id);
    expect((await tenantCol<any>(ORG, "care_plans").findOne({ _id: plan._id })).nextDue.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("paediatrics", () => {
  it("growth stores BMI only (no invented percentiles); vaccinations are not duplicated; minors without guardian are flagged", async () => {
    const g = await recordGrowth(doctor, { patientId: child, date: "2026-03-03", weightKg: 12, heightCm: 90, headCm: 48 });
    expect(g.bmi).toBeCloseTo(14.8, 1);
    expect(Object.keys(g)).not.toContain("percentile");
    await expect(recordGrowth(doctor, { patientId: child, date: "2020-01-01", weightKg: 5, heightCm: 50 })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await listGrowth(doctor, child)).toHaveLength(1);
    await recordVaccination(doctor, { patientId: child, vaccine: "MMR", dose: 1, date: "2024-03-10", batch: "B1" });
    await expect(recordVaccination(doctor, { patientId: child, vaccine: "MMR", dose: 1, date: "2024-04-10" })).rejects.toMatchObject({ code: "CONFLICT" });
    await recordVaccination(doctor, { patientId: child, vaccine: "MMR", dose: 2, date: "2025-03-10" });
    expect(await guardianCheck(doctor, child)).toHaveLength(1);
    expect(await guardianCheck(doctor, adult)).toHaveLength(0);
  });
});

describe("dermatology and aesthetics", () => {
  it("photos need consent; product use deducts stock and expenses it", async () => {
    const pr = await recordDermProcedure(doctor, { patientId: adult, procedure: "Chemical peel", areas: ["face"] });
    await expect(linkProcedurePhoto(doctor, pr._id, "att-1", "before")).rejects.toMatchObject({ code: "VALIDATION" });
    await grantPhotoConsent(reg, adult);
    await linkProcedurePhoto(doctor, pr._id, "att-1", "before");
    expect((await tenantCol<any>(ORG, "derm_procedures").findOne({ _id: pr._id })).photos).toHaveLength(1);

    const serum = (await createItem(im, { sku: "PEEL-1", name: "Peel solution", category: "consumable" }))._id;
    await withTransaction(async (s) => {
      const { value } = await receiveIntoStock(im, { itemId: serum, locationId: "clinic", batchNo: "S1", expiry: new Date(Date.now() + 200 * 86400000), qty: 10, unitCost: money("20.00"), refType: "t", refId: "t" }, s);
      const { postJournalSystem } = await import("@/modules/ledger/journal");
      const { accountBySystem } = await import("@/modules/ledger/accounts");
      await postJournalSystem(fin, { date: new Date(), memo: "open", sourceRef: { type: "t", id: "s1" }, idempotencyKey: "open-s1", lines: [{ accountId: (await accountBySystem(ORG, "inventory_consumables"))._id, debit: value.toFixed(2) }, { accountId: `${ORG}:3000`, credit: value.toFixed(2) }] }, s);
    });
    const cost = await recordProductUsage(doctor, { procedureId: pr._id, itemId: serum, qty: 2, locationId: "clinic" });
    expect(cost.toFixed(2)).toBe("40.00");
    expect((await stockOnHand(im, serum)).total).toBe(8);
    const tb = await trialBalance(fin, {});
    expect(tb.rows.find((r) => r.code === "5300")!.balance.toFixed(2)).toBe("40.00");
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
  });
});
