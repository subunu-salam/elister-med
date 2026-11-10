import type { Decimal128 } from "mongodb";
import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { fromDecimal128, money, sum, toDecimal128 } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { accountBySystem } from "@/modules/ledger/accounts";
import { postJournalSystem } from "@/modules/ledger/journal";
import { createServiceCharge } from "@/modules/billing/charges";
import { allocateFefo, allocationValue, inventoryAccountSystem, getItem } from "@/modules/inventory/service";
import { getPatient, contactInfo } from "@/modules/patients/service";
import { createFollowUp } from "@/modules/crm/service";

const v = <T>(r: { success: true; data: T } | { success: false; error: { message: string } }): T => { if (!r.success) throw new AppError("VALIDATION", r.error.message); return r.data; };
const write = async <T extends { _id: string }>(ctx: Ctx, col: string, doc: T, action: string) => {
  await withTransaction(async (s) => { await tenantCol<T>(ctx.orgId, col).insertOne(doc as never, s); await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action, resource: col, resourceId: doc._id, after: doc }); });
  return doc;
};
const needPatient = async (ctx: Ctx, id: string) => { if (!(await contactInfo(ctx, [id])).has(id)) throw new AppError("NOT_FOUND", "Patient not found"); };

// ================= Specialty template framework =================
export type SpecialtyTemplate = { _id: string; key: string; name: string; specialty: string; sections: { id: string; label: string; fields: { id: string; label: string; type: "text" | "number" | "choice" | "boolean"; options?: string[]; required?: boolean }[] }[]; version: number };
/** Specialties are configuration, not separate apps. A template defines structured sections; filled forms are stored append-only per encounter. */
export async function upsertSpecialtyTemplate(ctx: Ctx, input: Omit<SpecialtyTemplate, "_id" | "version">): Promise<SpecialtyTemplate> {
  assertPermission(ctx, "emr:approve");
  const d = v(z.object({ key: z.string().min(2), name: z.string().min(2), specialty: z.string().min(2), sections: z.array(z.object({ id: z.string(), label: z.string(), fields: z.array(z.object({ id: z.string(), label: z.string(), type: z.enum(["text", "number", "choice", "boolean"]), options: z.array(z.string()).optional(), required: z.boolean().optional() })) })).min(1) }).safeParse(input));
  const prev = (await tenantCol<SpecialtyTemplate>(ctx.orgId, "specialty_templates").find({ key: d.key } as never, { sort: { version: -1 }, limit: 1 }))[0];
  return write(ctx, "specialty_templates", { _id: newId(), ...d, version: (prev?.version ?? 0) + 1 }, "template.publish");
}
export async function listSpecialtyTemplates(ctx: Ctx) {
  assertPermission(ctx, "emr:view");
  const all = await tenantCol<SpecialtyTemplate>(ctx.orgId, "specialty_templates").find({} as never, { sort: { key: 1, version: -1 } });
  const seen = new Set<string>();
  return all.filter((t) => (seen.has(t.key) ? false : (seen.add(t.key), true)));
}
export async function saveEncounterForm(ctx: Ctx, input: { encounterId: string; templateKey: string; data: Record<string, unknown> }) {
  assertPermission(ctx, "emr:update");
  const t = (await tenantCol<SpecialtyTemplate>(ctx.orgId, "specialty_templates").find({ key: input.templateKey } as never, { sort: { version: -1 }, limit: 1 }))[0];
  if (!t) throw new AppError("NOT_FOUND", "Template not found");
  for (const sec of t.sections) for (const f of sec.fields) {
    const val = input.data[f.id];
    if (f.required && (val === undefined || val === "")) throw new AppError("VALIDATION", `${f.label} is required`);
    if (val !== undefined && f.type === "number" && !Number.isFinite(Number(val))) throw new AppError("VALIDATION", `${f.label} must be a number`);
    if (val !== undefined && f.type === "choice" && f.options && !f.options.includes(String(val))) throw new AppError("VALIDATION", `${f.label}: invalid choice`);
  }
  const prev = await tenantCol<{ version: number }>(ctx.orgId, "encounter_forms").find({ encounterId: input.encounterId, templateKey: input.templateKey } as never, { sort: { version: -1 }, limit: 1 });
  return write(ctx, "encounter_forms", { _id: newId(), encounterId: input.encounterId, templateKey: input.templateKey, templateVersion: t.version, data: input.data, version: (prev[0]?.version ?? 0) + 1, by: ctx.userId, at: new Date() }, "encounter_form.save");
}

// ================= Dental =================
const PERMANENT = [..."1234"].flatMap((q) => [1, 2, 3, 4, 5, 6, 7, 8].map((n) => Number(`${q}${n}`)));
const DECIDUOUS = [5, 6, 7, 8].flatMap((q) => [1, 2, 3, 4, 5].map((n) => Number(`${q}${n}`)));
export const isValidFdi = (t: number) => PERMANENT.includes(t) || DECIDUOUS.includes(t);
const SURFACES = ["M", "O", "D", "B", "L", "I"];
export type ToothRecord = { _id: string; patientId: string; tooth: number; surface?: string; condition: string; note?: string; at: Date; by: string };
export async function recordTooth(ctx: Ctx, input: { patientId: string; tooth: number; surface?: string; condition: string; note?: string }): Promise<ToothRecord> {
  assertPermission(ctx, "emr:update");
  if (!isValidFdi(input.tooth)) throw new AppError("VALIDATION", `${input.tooth} is not a valid FDI tooth number`);
  if (input.surface && !SURFACES.includes(input.surface)) throw new AppError("VALIDATION", "Surface must be one of M, O, D, B, L, I");
  if (!input.condition.trim()) throw new AppError("VALIDATION", "Condition required");
  await needPatient(ctx, input.patientId);
  return write(ctx, "dental_chart", { _id: newId(), ...input, at: new Date(), by: ctx.userId }, "dental.record");
}
export async function getDentalChart(ctx: Ctx, patientId: string) {
  assertPermission(ctx, "emr:view");
  const rows = await tenantCol<ToothRecord>(ctx.orgId, "dental_chart").find({ patientId } as never, { sort: { at: 1 } });
  const latest = new Map<string, ToothRecord>();
  for (const r of rows) latest.set(`${r.tooth}${r.surface ?? ""}`, r);
  return { entries: [...latest.values()].sort((a, b) => a.tooth - b.tooth), history: rows };
}

export type PlanItem = { tooth: number; serviceId: string; serviceName: string; price: Decimal128; status: "planned" | "done"; doneAt?: Date; encounterId?: string };
export type TreatmentPlan = { _id: string; patientId: string; items: PlanItem[]; estimate: Decimal128; status: "active" | "completed" | "cancelled"; createdBy: string; at: Date };
/** Multi-visit plan with an itemised estimate from the service catalogue. Completing an item creates its charge exactly once. */
export async function createTreatmentPlan(ctx: Ctx, input: { patientId: string; items: { tooth: number; serviceId: string }[] }): Promise<TreatmentPlan> {
  assertPermission(ctx, "emr:update");
  if (!input.items.length) throw new AppError("VALIDATION", "Add at least one item");
  await needPatient(ctx, input.patientId);
  const items: PlanItem[] = [];
  for (const i of input.items) {
    if (!isValidFdi(i.tooth)) throw new AppError("VALIDATION", `${i.tooth} is not a valid FDI tooth number`);
    const svc = await tenantCol<{ _id: string; name: string; price: Decimal128 }>(ctx.orgId, "services").findOne({ _id: i.serviceId, active: true } as never);
    if (!svc) throw new AppError("NOT_FOUND", "Service not found");
    items.push({ tooth: i.tooth, serviceId: svc._id, serviceName: svc.name, price: svc.price, status: "planned" });
  }
  return write(ctx, "treatment_plans", { _id: newId(), patientId: input.patientId, items, estimate: toDecimal128(sum(items.map((i) => fromDecimal128(i.price)))), status: "active" as const, createdBy: ctx.userId, at: new Date() }, "plan.create");
}
export async function completePlanItem(ctx: Ctx, planId: string, index: number, encounterId: string): Promise<TreatmentPlan> {
  assertPermission(ctx, "emr:update");
  return withTransaction(async (s) => {
    const p = await tenantCol<TreatmentPlan>(ctx.orgId, "treatment_plans").findOne({ _id: planId } as never, s);
    if (!p) throw new AppError("NOT_FOUND", "Plan not found");
    const it = p.items[index];
    if (!it) throw new AppError("NOT_FOUND", "Plan item not found");
    if (it.status === "done") throw new AppError("CONFLICT", "This item is already completed");
    await createServiceCharge(ctx, { encounterId, patientId: p.patientId, serviceId: it.serviceId, qty: 1, autoKey: `plan:${planId}:${index}` }, s);
    const items = p.items.map((x, i) => (i === index ? { ...x, status: "done" as const, doneAt: new Date(), encounterId } : x));
    const all = items.every((x) => x.status === "done");
    await tenantCol<TreatmentPlan>(ctx.orgId, "treatment_plans").updateOne({ _id: planId } as never, { $set: { items, status: all ? "completed" : "active" } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "plan.item_done", resource: "treatment_plans", resourceId: planId, after: { index, tooth: it.tooth } });
    return { ...p, items, status: all ? "completed" : "active" };
  });
}
export async function listPlans(ctx: Ctx, patientId: string) { assertPermission(ctx, "emr:view"); return tenantCol<TreatmentPlan>(ctx.orgId, "treatment_plans").find({ patientId } as never, { sort: { at: -1 } }); }

// ================= Session packages (physio, aesthetics, dental) =================
export type SessionPackage = { _id: string; patientId: string; name: string; sessions: number; used: number; serviceId?: string; price: Decimal128; status: "active" | "exhausted"; at: Date; log: { at: Date; by: string; note?: string }[] };
export async function sellPackage(ctx: Ctx, input: { patientId: string; name: string; sessions: number; price: string; serviceId?: string }): Promise<SessionPackage> {
  assertPermission(ctx, "billing:create");
  const d = v(z.object({ patientId: z.string(), name: z.string().min(2), sessions: z.number().int().min(1).max(200), price: z.string().regex(/^\d+(\.\d{1,2})?$/) }).passthrough().safeParse(input));
  await needPatient(ctx, input.patientId);
  return write(ctx, "packages", { _id: newId(), patientId: d.patientId, name: d.name, sessions: d.sessions, used: 0, serviceId: input.serviceId, price: toDecimal128(money(d.price)), status: "active" as const, at: new Date(), log: [] }, "package.sell");
}
/** Atomic: the balance can never go below zero, even under concurrent consumption. */
export async function consumeSession(ctx: Ctx, packageId: string, note?: string): Promise<SessionPackage> {
  assertPermission(ctx, "emr:update");
  return withTransaction(async (s) => {
    const col = tenantCol<SessionPackage>(ctx.orgId, "packages");
    const r = await col.findOneAndUpdate({ _id: packageId, status: "active", $expr: { $lt: ["$used", "$sessions"] } } as never, { $inc: { used: 1 }, $push: { log: { at: new Date(), by: ctx.userId, note } } } as never, undefined, s);
    if (!r) throw new AppError("CONFLICT", "Package not found or no sessions remaining");
    if (r.used >= r.sessions) await col.updateOne({ _id: packageId } as never, { $set: { status: "exhausted" } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "package.consume", resource: "packages", resourceId: packageId, after: { used: r.used } });
    return r;
  });
}
export async function listPackages(ctx: Ctx, patientId: string) { assertPermission(ctx, "emr:view"); return tenantCol<SessionPackage>(ctx.orgId, "packages").find({ patientId } as never, { sort: { at: -1 } }); }

// ================= Measurements: physio progress, chronic care, trends =================
export type Measurement = { _id: string; patientId: string; kind: string; value: number; unit: string; at: Date; by: string };
export async function recordMeasurement(ctx: Ctx, input: { patientId: string; kind: string; value: number; unit: string; at?: Date }): Promise<Measurement> {
  assertPermission(ctx, "emr:update");
  if (!Number.isFinite(input.value)) throw new AppError("VALIDATION", "Value must be a number");
  if (!input.kind.trim() || !input.unit.trim()) throw new AppError("VALIDATION", "Kind and unit required");
  await needPatient(ctx, input.patientId);
  return write(ctx, "measurements", { _id: newId(), ...input, at: input.at ?? new Date(), by: ctx.userId }, "measurement.record");
}
export async function measurementTrend(ctx: Ctx, patientId: string, kind: string) {
  assertPermission(ctx, "emr:view");
  const pts = await tenantCol<Measurement>(ctx.orgId, "measurements").find({ patientId, kind } as never, { sort: { at: 1 }, limit: 1000 });
  const delta = pts.length >= 2 ? pts[pts.length - 1].value - pts[0].value : null;
  return { points: pts.map((p) => ({ at: p.at, value: p.value, unit: p.unit })), delta, direction: delta === null ? null : delta > 0 ? "up" : delta < 0 ? "down" : "flat" };
}
export async function logPhysioSession(ctx: Ctx, input: { patientId: string; packageId?: string; attendance: "attended" | "missed"; exercises: string[]; notes?: string }) {
  assertPermission(ctx, "emr:update");
  await needPatient(ctx, input.patientId);
  if (input.attendance === "attended" && input.packageId) await consumeSession(ctx, input.packageId, input.notes);
  return write(ctx, "physio_sessions", { _id: newId(), ...input, at: new Date(), by: ctx.userId }, "physio.session");
}

// ================= Chronic care plans =================
export type CarePlan = { _id: string; patientId: string; condition: string; intervalDays: number; kinds: string[]; nextDue: Date; active: boolean; createdBy: string };
export async function setCarePlan(ctx: Ctx, input: { patientId: string; condition: string; intervalDays: number; kinds: string[] }): Promise<CarePlan> {
  assertPermission(ctx, "emr:update");
  const d = v(z.object({ patientId: z.string(), condition: z.string().min(2), intervalDays: z.number().int().min(1).max(730), kinds: z.array(z.string()).min(1) }).safeParse(input));
  await needPatient(ctx, d.patientId);
  return write(ctx, "care_plans", { _id: newId(), ...d, nextDue: new Date(Date.now() + d.intervalDays * 86400000), active: true, createdBy: ctx.userId }, "careplan.set");
}
/** Care reminders become CRM follow-up tasks (one per plan per due date). */
export async function generateCareReminders(ctx: Ctx): Promise<number> {
  assertPermission(ctx, "crm:create");
  const due = await tenantCol<CarePlan>(ctx.orgId, "care_plans").find({ active: true, nextDue: { $lte: new Date() } } as never, { limit: 500 });
  let n = 0;
  for (const p of due) { const f = await createFollowUp(ctx, { patientId: p.patientId, kind: "chronic_care", dueAt: p.nextDue, note: "Chronic care follow-up is due: contact the patient to book", dedupeKey: `care:${p._id}:${p.nextDue.toISOString().slice(0, 10)}` }); if (f) n++; }
  return n;
}
export async function completeCareVisit(ctx: Ctx, planId: string) {
  assertPermission(ctx, "emr:update");
  const p = await tenantCol<CarePlan>(ctx.orgId, "care_plans").findOne({ _id: planId } as never);
  if (!p) throw new AppError("NOT_FOUND", "Care plan not found");
  await tenantCol<CarePlan>(ctx.orgId, "care_plans").updateOne({ _id: planId } as never, { $set: { nextDue: new Date(Date.now() + p.intervalDays * 86400000) } } as never);
}

// ================= Paediatrics =================
export type GrowthRecord = { _id: string; patientId: string; date: string; weightKg: number; heightCm: number; headCm?: number; bmi: number; by: string };
/** Stores measurements and BMI only. No percentile/z-score is computed: that needs the validated reference tables the clinic chooses to adopt. */
export async function recordGrowth(ctx: Ctx, input: { patientId: string; date: string; weightKg: number; heightCm: number; headCm?: number }): Promise<GrowthRecord> {
  assertPermission(ctx, "emr:update");
  const d = v(z.object({ patientId: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), weightKg: z.number().min(0.3).max(250), heightCm: z.number().min(20).max(230), headCm: z.number().min(15).max(70).optional() }).safeParse(input));
  const p = await getPatient(ctx, d.patientId);
  if (d.date < p.dob) throw new AppError("VALIDATION", "Measurement date is before birth");
  const bmi = Math.round((d.weightKg / (d.heightCm / 100) ** 2) * 10) / 10;
  return write(ctx, "growth_records", { _id: newId(), ...d, bmi, by: ctx.userId }, "growth.record");
}
export async function listGrowth(ctx: Ctx, patientId: string) { assertPermission(ctx, "emr:view"); return tenantCol<GrowthRecord>(ctx.orgId, "growth_records").find({ patientId } as never, { sort: { date: 1 } }); }
export type Vaccination = { _id: string; patientId: string; vaccine: string; dose: number; date: string; batch?: string; by: string };
export async function recordVaccination(ctx: Ctx, input: { patientId: string; vaccine: string; dose: number; date: string; batch?: string }): Promise<Vaccination> {
  assertPermission(ctx, "emr:update");
  const d = v(z.object({ patientId: z.string(), vaccine: z.string().min(2), dose: z.number().int().min(1).max(10), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).passthrough().safeParse(input));
  await needPatient(ctx, d.patientId);
  const dup = await tenantCol<Vaccination>(ctx.orgId, "vaccinations").findOne({ patientId: d.patientId, vaccine: d.vaccine, dose: d.dose } as never);
  if (dup) throw new AppError("CONFLICT", `${d.vaccine} dose ${d.dose} is already recorded`);
  return write(ctx, "vaccinations", { _id: newId(), patientId: d.patientId, vaccine: d.vaccine, dose: d.dose, date: d.date, batch: input.batch, by: ctx.userId }, "vaccination.record");
}
export async function vaccinationHistory(ctx: Ctx, patientId: string) { assertPermission(ctx, "emr:view"); return tenantCol<Vaccination>(ctx.orgId, "vaccinations").find({ patientId } as never, { sort: { date: 1 } }); }
/** Minors need a linked guardian. Returns a warning list rather than blocking care. */
export async function guardianCheck(ctx: Ctx, patientId: string): Promise<string[]> {
  const p = await getPatient(ctx, patientId);
  const age = (Date.now() - new Date(p.dob).getTime()) / (365.25 * 86400000);
  return age < 18 && !p.guardianPatientId ? ["Patient is a minor and has no linked guardian record"] : [];
}

// ================= Dermatology / aesthetics =================
export type DermProcedure = { _id: string; patientId: string; procedure: string; areas: string[]; notes?: string; photos: { attachmentId: string; kind: "before" | "after" }[]; products: { itemId: string; qty: number; cost: Decimal128 }[]; at: Date; by: string };
export async function recordDermProcedure(ctx: Ctx, input: { patientId: string; procedure: string; areas: string[]; notes?: string }): Promise<DermProcedure> {
  assertPermission(ctx, "emr:update");
  if (!input.procedure.trim()) throw new AppError("VALIDATION", "Procedure required");
  await needPatient(ctx, input.patientId);
  return write(ctx, "derm_procedures", { _id: newId(), ...input, photos: [], products: [], at: new Date(), by: ctx.userId }, "derm.procedure");
}
/** Photographs are only linked when the patient has an explicit, granted photography consent on file. */
export async function linkProcedurePhoto(ctx: Ctx, procedureId: string, attachmentId: string, kind: "before" | "after") {
  assertPermission(ctx, "emr:update");
  const pr = await tenantCol<DermProcedure>(ctx.orgId, "derm_procedures").findOne({ _id: procedureId } as never);
  if (!pr) throw new AppError("NOT_FOUND", "Procedure not found");
  const p = await getPatient(ctx, pr.patientId);
  const ok = (p.consents as { type: string; granted: boolean }[]).some((c) => c.type === "photography" && c.granted);
  if (!ok) throw new AppError("VALIDATION", "No photography consent on file for this patient");
  await tenantCol(ctx.orgId, "derm_procedures").updateOne({ _id: procedureId } as never, { $push: { photos: { attachmentId, kind } } } as never);
}
export async function grantPhotoConsent(ctx: Ctx, patientId: string) {
  assertPermission(ctx, "patients:update");
  await needPatient(ctx, patientId);
  await tenantCol(ctx.orgId, "patients").updateOne({ _id: patientId } as never, { $push: { consents: { type: "photography", granted: true, at: new Date() } } } as never);
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "consent.photography", resource: "patient", resourceId: patientId }));
}
/** Product usage deducts stock (FEFO) and expenses it: Dr Medical consumables / Cr Inventory. */
export async function recordProductUsage(ctx: Ctx, input: { procedureId: string; itemId: string; qty: number; locationId: string }) {
  assertPermission(ctx, "emr:update");
  return withTransaction(async (s) => {
    const pr = await tenantCol<DermProcedure>(ctx.orgId, "derm_procedures").findOne({ _id: input.procedureId } as never, s);
    if (!pr) throw new AppError("NOT_FOUND", "Procedure not found");
    const item = await getItem(ctx, input.itemId).catch(() => { throw new AppError("NOT_FOUND", "Item not found"); });
    const al = await allocateFefo(ctx, { itemId: input.itemId, locationId: input.locationId, qty: input.qty, refType: "procedure", refId: input.procedureId }, s);
    const cost = allocationValue(al);
    await postJournalSystem(ctx, { date: new Date(), memo: `Procedure product use: ${item.name}`, sourceRef: { type: "procedure_usage", id: input.procedureId }, idempotencyKey: `procuse:${newId()}`,
      lines: [{ accountId: (await tenantCol<{ _id: string }>(ctx.orgId, "accounts").findOne({ code: "5300" } as never, s))!._id, debit: cost.toFixed(2) }, { accountId: (await accountBySystem(ctx.orgId, inventoryAccountSystem(item)))._id, credit: cost.toFixed(2) }] }, s);
    await tenantCol(ctx.orgId, "derm_procedures").updateOne({ _id: input.procedureId } as never, { $push: { products: { itemId: input.itemId, qty: input.qty, cost: toDecimal128(cost) } } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "derm.product_use", resource: "derm_procedures", resourceId: input.procedureId, after: { itemId: input.itemId, qty: input.qty } });
    return cost;
  });
}
