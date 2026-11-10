import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { emit } from "@/core/outbox";
import { nextSeq } from "@/core/counters";
import { precreateLock, bumpLock } from "@/core/locks";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { createServiceCharge } from "@/modules/billing/charges";
import { allocateFefo, allocationValue, getItem, inventoryAccountSystem } from "@/modules/inventory/service";
import { accountBySystem } from "@/modules/ledger/accounts";
import { postJournalSystem } from "@/modules/ledger/journal";
import { getPatient, contactInfo } from "@/modules/patients/service";
import { docNo, yearOf } from "@/modules/billing/invoice";

const v = <T>(r: { success: true; data: T } | { success: false; error: { message: string } }): T => { if (!r.success) throw new AppError("VALIDATION", r.error.message); return r.data; };

/** Inpatient, emergency and theatre features are optional modules, off by default. Outpatient-only clinics never see them. */
async function gate(ctx: Ctx) {
  const o = await tenantCol<{ modules?: { hospital?: boolean } }>(ctx.orgId, "orgs").findOne({ _id: ctx.orgId } as never);
  if (!o?.modules?.hospital) throw new AppError("CONFLICT", "Hospital modules are not enabled for this organisation");
}
const need = async (ctx: Ctx, perm: Parameters<typeof assertPermission>[1]) => { assertPermission(ctx, perm); await gate(ctx); };
const rec = async <T extends { _id: string }>(ctx: Ctx, col: string, doc: T, action: string) => {
  await withTransaction(async (s) => { await tenantCol<T>(ctx.orgId, col).insertOne(doc as never, s); await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action, resource: col, resourceId: doc._id, after: doc }); });
  return doc;
};

export async function setHospitalConfig(ctx: Ctx, cfg: { bedServiceId?: string; theatreServiceId?: string; erThresholdsMinutes?: Record<string, number> }) {
  await need(ctx, "hospital:approve");
  await withTransaction(async (s) => {
    await tenantCol(ctx.orgId, "hospital_config").updateOne({ key: "main" } as never, { $set: { cfg } } as never, s, { upsert: true });
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "hospital.config", resource: "hospital_config", resourceId: "main", after: cfg });
  });
}
async function cfg(ctx: Ctx) { return (await tenantCol<{ cfg: { bedServiceId?: string; theatreServiceId?: string; erThresholdsMinutes?: Record<string, number> } }>(ctx.orgId, "hospital_config").findOne({ key: "main" } as never))?.cfg ?? {}; }

// ================= Wards and beds =================
export type Bed = { _id: string; wardId: string; bedNo: string; status: "free" | "occupied" | "cleaning" | "blocked"; admissionId?: string };
export async function createWard(ctx: Ctx, input: { code: string; name: string }) { await need(ctx, "hospital:create"); return rec(ctx, "wards", { _id: newId(), ...v(z.object({ code: z.string().min(1), name: z.string().min(2) }).safeParse(input)) }, "ward.create"); }
export async function createBed(ctx: Ctx, input: { wardId: string; bedNo: string }) {
  await need(ctx, "hospital:create");
  if (!(await tenantCol(ctx.orgId, "wards").findOne({ _id: input.wardId } as never))) throw new AppError("NOT_FOUND", "Ward not found");
  try { return await rec<Bed>(ctx, "beds", { _id: newId(), wardId: input.wardId, bedNo: input.bedNo, status: "free" }, "bed.create"); }
  catch (e) { if ((e as { code?: number }).code === 11000) throw new AppError("CONFLICT", "Bed number already exists in this ward"); throw e; }
}
export async function bedBoard(ctx: Ctx) {
  await need(ctx, "hospital:view");
  const wards = await tenantCol<{ _id: string; code: string; name: string }>(ctx.orgId, "wards").find({} as never, { sort: { code: 1 } });
  const beds = await tenantCol<Bed>(ctx.orgId, "beds").find({} as never, { sort: { bedNo: 1 }, limit: 2000 });
  return wards.map((w) => { const b = beds.filter((x) => x.wardId === w._id); return { ...w, beds: b, occupancy: b.length ? b.filter((x) => x.status === "occupied").length / b.length : 0 }; });
}
export async function markBedClean(ctx: Ctx, bedId: string) {
  await need(ctx, "hospital:update");
  const r = await tenantCol<Bed>(ctx.orgId, "beds").updateOne({ _id: bedId, status: "cleaning" } as never, { $set: { status: "free" } } as never);
  if (r.matchedCount === 0) throw new AppError("CONFLICT", "Bed is not awaiting cleaning");
}

// ================= Admissions =================
export type Admission = { _id: string; number: string; patientId: string; bedId: string; doctorId: string; reason: string; status: "admitted" | "discharged"; admittedAt: Date; dischargedAt?: Date; summary?: string; disposition?: string; transfers: { from: string; to: string; at: Date; by: string }[]; source?: string; carePlans: { at: Date; by: string; goals: string[]; interventions: string[] }[] };
const adms = (o: string) => tenantCol<Admission>(o, "admissions");

/** Beds are claimed atomically (free -> occupied): two simultaneous admissions to one bed cannot both succeed. */
export async function admitPatient(ctx: Ctx, input: { patientId: string; bedId: string; doctorId: string; reason: string; source?: string }): Promise<Admission> {
  await need(ctx, "hospital:create");
  if (!input.reason.trim()) throw new AppError("VALIDATION", "Admission reason required");
  if (!(await contactInfo(ctx, [input.patientId])).has(input.patientId)) throw new AppError("NOT_FOUND", "Patient not found");
  return withTransaction(async (s) => {
    if (await adms(ctx.orgId).count({ patientId: input.patientId, status: "admitted" } as never, s)) throw new AppError("CONFLICT", "Patient is already admitted");
    const bed = await tenantCol<Bed>(ctx.orgId, "beds").findOneAndUpdate({ _id: input.bedId, status: "free" } as never, { $set: { status: "occupied" } } as never, undefined, s);
    if (!bed) throw new AppError("CONFLICT", "Bed is not available");
    const year = yearOf();
    const a: Admission = { _id: newId(), number: docNo("ADM", year, await nextSeq(ctx.orgId, `adm:${year}`, s)), ...input, status: "admitted", admittedAt: new Date(), transfers: [], carePlans: [] };
    await adms(ctx.orgId).insertOne(a, s);
    await tenantCol<Bed>(ctx.orgId, "beds").updateOne({ _id: bed._id } as never, { $set: { admissionId: a._id } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "admission.admit", resource: "admissions", resourceId: a._id, after: { number: a.number, bedId: input.bedId } });
    await emit(s, ctx.orgId, "admission.admitted", { admissionId: a._id });
    return a;
  });
}
export async function transferBed(ctx: Ctx, admissionId: string, toBedId: string) {
  await need(ctx, "hospital:update");
  return withTransaction(async (s) => {
    const a = await adms(ctx.orgId).findOne({ _id: admissionId, status: "admitted" } as never, s);
    if (!a) throw new AppError("NOT_FOUND", "Active admission not found");
    const nb = await tenantCol<Bed>(ctx.orgId, "beds").findOneAndUpdate({ _id: toBedId, status: "free" } as never, { $set: { status: "occupied", admissionId } } as never, undefined, s);
    if (!nb) throw new AppError("CONFLICT", "Destination bed is not available");
    await tenantCol<Bed>(ctx.orgId, "beds").updateOne({ _id: a.bedId } as never, { $set: { status: "cleaning" }, $unset: { admissionId: "" } } as never, s);
    await adms(ctx.orgId).updateOne({ _id: admissionId } as never, { $set: { bedId: toBedId }, $push: { transfers: { from: a.bedId, to: toBedId, at: new Date(), by: ctx.userId } } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "admission.transfer", resource: "admissions", resourceId: admissionId, after: { from: a.bedId, to: toBedId } });
  });
}
export async function setInpatientCarePlan(ctx: Ctx, admissionId: string, plan: { goals: string[]; interventions: string[] }) {
  await need(ctx, "hospital:update");
  if (!plan.goals.length) throw new AppError("VALIDATION", "At least one goal required");
  const r = await adms(ctx.orgId).updateOne({ _id: admissionId, status: "admitted" } as never, { $push: { carePlans: { at: new Date(), by: ctx.userId, ...plan } } } as never);
  if (r.matchedCount === 0) throw new AppError("NOT_FOUND", "Active admission not found");
}

export type Observation = { _id: string; admissionId: string; at: Date; by: string; systolic?: number; diastolic?: number; heartRate?: number; spo2?: number; tempC?: number; respRate?: number; note?: string };
export async function recordObservation(ctx: Ctx, input: Omit<Observation, "_id" | "at" | "by">) {
  await need(ctx, "hospital:update");
  v(z.object({ admissionId: z.string(), systolic: z.number().min(40).max(300).optional(), diastolic: z.number().min(20).max(200).optional(), heartRate: z.number().min(20).max(250).optional(), spo2: z.number().min(50).max(100).optional(), tempC: z.number().min(30).max(45).optional(), respRate: z.number().min(4).max(80).optional() }).passthrough().safeParse(input));
  if (!(await adms(ctx.orgId).findOne({ _id: input.admissionId, status: "admitted" } as never))) throw new AppError("NOT_FOUND", "Active admission not found");
  return rec<Observation>(ctx, "observations", { _id: newId(), ...input, at: new Date(), by: ctx.userId }, "observation.record");
}

// ================= Medication administration record =================
export type MarEntry = { _id: string; admissionId: string; orderId: string; itemId: string; name: string; dose: string; route: string; scheduledAt: Date; status: "scheduled" | "given" | "held" | "refused"; by?: string; at?: Date; reason?: string };
/** Doctor's inpatient medication order creates the dose schedule for the next 24h. Allergy name-matches need a documented override (no interaction checking is performed). */
export async function orderInpatientMedication(ctx: Ctx, input: { admissionId: string; itemId: string; dose: string; route: string; everyHours: number; startAt?: Date; allergyOverride?: string }) {
  await need(ctx, "hospital:approve");
  if (!Number.isInteger(input.everyHours) || input.everyHours < 1 || input.everyHours > 24) throw new AppError("VALIDATION", "Frequency must be 1-24 hours");
  const a = await adms(ctx.orgId).findOne({ _id: input.admissionId, status: "admitted" } as never);
  if (!a) throw new AppError("NOT_FOUND", "Active admission not found");
  const p = await getPatient(ctx, a.patientId), item = await getItem(ctx, input.itemId);
  if (item.controlled) throw new AppError("CONFLICT", "Controlled medicines need the regulatory authorization process, which is not configured here");
  const hit = p.allergies.find((al) => al.substance && (item.name + " " + (item.genericName ?? "")).toLowerCase().includes(al.substance.toLowerCase()));
  if (hit && !input.allergyOverride?.trim()) throw new AppError("CONFLICT", `Allergy alert: patient allergy "${hit.substance}" matches ${item.name}. Document an override reason or choose another drug.`);
  const start = input.startAt ?? new Date(), orderId = newId();
  const doses: MarEntry[] = Array.from({ length: Math.floor(24 / input.everyHours) }, (_, i) => ({ _id: newId(), admissionId: input.admissionId, orderId, itemId: item._id, name: item.name, dose: input.dose, route: input.route, scheduledAt: new Date(start.getTime() + i * input.everyHours * 3600_000), status: "scheduled" as const }));
  await withTransaction(async (s) => {
    await tenantCol<MarEntry>(ctx.orgId, "mar").insertMany(doses, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "mar.order", resource: "admissions", resourceId: input.admissionId, after: { item: item.name, doses: doses.length, override: input.allergyOverride ?? null } });
  });
  return doses;
}
export async function administerDose(ctx: Ctx, marId: string, outcome: { status: "given" | "held" | "refused"; reason?: string }) {
  await need(ctx, "hospital:update");
  if (outcome.status !== "given" && !outcome.reason?.trim()) throw new AppError("VALIDATION", "A reason is required when a dose is held or refused");
  const r = await tenantCol<MarEntry>(ctx.orgId, "mar").updateOne({ _id: marId, status: "scheduled" } as never, { $set: { status: outcome.status, by: ctx.userId, at: new Date(), reason: outcome.reason } } as never);
  if (r.matchedCount === 0) throw new AppError("CONFLICT", "Dose not found or already recorded");
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: `mar.${outcome.status}`, resource: "mar", resourceId: marId, after: outcome }));
}
export async function listMar(ctx: Ctx, admissionId: string) { await need(ctx, "hospital:view"); return tenantCol<MarEntry>(ctx.orgId, "mar").find({ admissionId } as never, { sort: { scheduledAt: 1 }, limit: 500 }); }

/** Discharge: summary required, bed goes to cleaning, bed-day charges (per configured bed service) are created once per calendar day of stay. */
export async function dischargePatient(ctx: Ctx, admissionId: string, input: { summary: string; disposition: "home" | "transfer" | "against_advice" | "deceased"; at?: Date }) {
  await need(ctx, "hospital:approve");
  if (!input.summary.trim()) throw new AppError("VALIDATION", "A discharge summary is required");
  const c = await cfg(ctx);
  return withTransaction(async (s) => {
    const a = await adms(ctx.orgId).findOne({ _id: admissionId, status: "admitted" } as never, s);
    if (!a) throw new AppError("NOT_FOUND", "Active admission not found");
    const at = input.at ?? new Date();
    await adms(ctx.orgId).updateOne({ _id: admissionId, status: "admitted" } as never, { $set: { status: "discharged", dischargedAt: at, summary: input.summary, disposition: input.disposition } } as never, s);
    await tenantCol<Bed>(ctx.orgId, "beds").updateOne({ _id: a.bedId } as never, { $set: { status: "cleaning" }, $unset: { admissionId: "" } } as never, s);
    const days = Math.max(1, Math.ceil((at.getTime() - a.admittedAt.getTime()) / 86400000));
    let charged = 0;
    if (c.bedServiceId) for (let d = 0; d < days; d++) { await createServiceCharge(ctx, { encounterId: a._id, patientId: a.patientId, serviceId: c.bedServiceId, qty: 1, autoKey: `bed:${a._id}:${d}` }, s); charged++; }
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "admission.discharge", resource: "admissions", resourceId: admissionId, after: { days, disposition: input.disposition } });
    return { days, bedDaysCharged: charged, warning: c.bedServiceId ? undefined : "No bed-day service configured: no charges were created" };
  });
}
export async function listAdmissions(ctx: Ctx, status: Admission["status"] = "admitted") { await need(ctx, "hospital:view"); return adms(ctx.orgId).find({ status } as never, { sort: { admittedAt: -1 }, limit: 300 }); }

// ================= Emergency department =================
export type ErVisit = {
  _id: string; number: string; patientId?: string; alias?: string; complaint: string; arrivalAt: Date; arrivalMode: string; status: "waiting" | "in_treatment" | "disposed";
  triage?: { level: 1 | 2 | 3 | 4 | 5; by: string; at: Date; note?: string; vitals?: Record<string, number> }; team?: { doctorId?: string; nurseId?: string };
  disposition?: { type: "admit" | "discharge" | "transfer" | "left_without_being_seen"; note: string; receivingFacility?: string; admissionId?: string; at: Date; by: string };
};
const er = (o: string) => tenantCol<ErVisit>(o, "er_visits");

export async function registerEr(ctx: Ctx, input: { patientId?: string; alias?: string; complaint: string; arrivalMode: string }): Promise<ErVisit> {
  await need(ctx, "hospital:create");
  if (!input.patientId && !input.alias) throw new AppError("VALIDATION", "Give a patient or a temporary alias (unknown patient)");
  if (!input.complaint.trim()) throw new AppError("VALIDATION", "Presenting complaint required");
  if (input.patientId && !(await contactInfo(ctx, [input.patientId])).has(input.patientId)) throw new AppError("NOT_FOUND", "Patient not found");
  return withTransaction(async (s) => {
    const year = yearOf();
    const e: ErVisit = { _id: newId(), number: docNo("ER", year, await nextSeq(ctx.orgId, `er:${year}`, s)), ...input, arrivalAt: new Date(), status: "waiting" };
    await er(ctx.orgId).insertOne(e, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "er.register", resource: "er_visits", resourceId: e._id });
    return e;
  });
}
/** The clinician assigns the level. No algorithm decides it; the scale and its use must be clinically validated by the facility. */
export async function triage(ctx: Ctx, visitId: string, input: { level: 1 | 2 | 3 | 4 | 5; note?: string; vitals?: Record<string, number> }) {
  await need(ctx, "hospital:update");
  if (![1, 2, 3, 4, 5].includes(input.level)) throw new AppError("VALIDATION", "Level must be 1-5");
  const r = await er(ctx.orgId).updateOne({ _id: visitId, status: { $ne: "disposed" } } as never, { $set: { triage: { ...input, by: ctx.userId, at: new Date() } } } as never);
  if (r.matchedCount === 0) throw new AppError("NOT_FOUND", "Open ER visit not found");
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "er.triage", resource: "er_visits", resourceId: visitId, after: { level: input.level } }));
}
export async function assignErTeam(ctx: Ctx, visitId: string, team: { doctorId?: string; nurseId?: string }) {
  await need(ctx, "hospital:update");
  const r = await er(ctx.orgId).updateOne({ _id: visitId, status: { $ne: "disposed" } } as never, { $set: { team, status: "in_treatment" } } as never);
  if (r.matchedCount === 0) throw new AppError("NOT_FOUND", "Open ER visit not found");
}
/** Most urgent first (level 1 highest), then longest wait. Untriaged patients are listed first so they are never forgotten. */
export async function erQueue(ctx: Ctx) {
  await need(ctx, "hospital:view");
  const open = await er(ctx.orgId).find({ status: { $ne: "disposed" } } as never, { limit: 500 });
  return open.sort((a, b) => (a.triage?.level ?? 0) - (b.triage?.level ?? 0) || a.arrivalAt.getTime() - b.arrivalAt.getTime());
}
/** Waiting longer than the configured per-level threshold (minutes). No thresholds configured means no escalation is invented. */
export async function erEscalations(ctx: Ctx, now = new Date()) {
  await need(ctx, "hospital:view");
  const th = (await cfg(ctx)).erThresholdsMinutes ?? {};
  return (await erQueue(ctx)).filter((e) => e.status === "waiting" && e.triage && th[String(e.triage.level)] !== undefined && (now.getTime() - e.arrivalAt.getTime()) / 60000 > th[String(e.triage.level)]).map((e) => ({ visitId: e._id, number: e.number, level: e.triage!.level, waitingMinutes: Math.round((now.getTime() - e.arrivalAt.getTime()) / 60000) }));
}
export async function disposeEr(ctx: Ctx, visitId: string, input: { type: NonNullable<ErVisit["disposition"]>["type"]; note: string; receivingFacility?: string; bedId?: string; doctorId?: string }) {
  await need(ctx, "hospital:approve");
  const e = await er(ctx.orgId).findOne({ _id: visitId, status: { $ne: "disposed" } } as never);
  if (!e) throw new AppError("NOT_FOUND", "Open ER visit not found");
  if (!input.note.trim()) throw new AppError("VALIDATION", "Disposition note required");
  if (input.type !== "left_without_being_seen" && !e.triage) throw new AppError("CONFLICT", "Triage must be recorded before disposition");
  if (input.type === "transfer" && !input.receivingFacility?.trim()) throw new AppError("VALIDATION", "Transfer documentation needs the receiving facility");
  let admissionId: string | undefined;
  if (input.type === "admit") {
    if (!e.patientId) throw new AppError("CONFLICT", "Register the unknown patient before admitting");
    if (!input.bedId || !input.doctorId) throw new AppError("VALIDATION", "Admission needs a bed and a responsible doctor");
    admissionId = (await admitPatient(ctx, { patientId: e.patientId, bedId: input.bedId, doctorId: input.doctorId, reason: `ER admission ${e.number}: ${e.complaint}`, source: "er" }))._id;
  }
  await er(ctx.orgId).updateOne({ _id: visitId } as never, { $set: { status: "disposed", disposition: { type: input.type, note: input.note, receivingFacility: input.receivingFacility, admissionId, at: new Date(), by: ctx.userId } } } as never);
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "er.dispose", resource: "er_visits", resourceId: visitId, after: { type: input.type, admissionId } }));
  return { admissionId };
}
export async function linkErPatient(ctx: Ctx, visitId: string, patientId: string) {
  await need(ctx, "hospital:update");
  if (!(await contactInfo(ctx, [patientId])).has(patientId)) throw new AppError("NOT_FOUND", "Patient not found");
  const r = await er(ctx.orgId).updateOne({ _id: visitId, patientId: { $exists: false } } as never, { $set: { patientId } } as never);
  if (r.matchedCount === 0) throw new AppError("CONFLICT", "Visit not found or already linked");
}

// ================= Operating theatre =================
export type Surgery = {
  _id: string; number: string; theatreId: string; patientId: string; procedure: string; surgeonId: string; team: string[]; start: Date; end: Date;
  status: "scheduled" | "in_theatre" | "recovery" | "completed" | "cancelled"; checklist: { item: string; done: boolean; by?: string }[]; notes?: string; recovery: { at: Date; by: string; note: string }[]; materials: { itemId: string; qty: number }[]; cancelReason?: string;
};
const CHECKLIST = ["Identity and consent verified", "Surgical site marked", "Allergies reviewed", "Fasting status confirmed", "Equipment and implants ready"];
const sx = (o: string) => tenantCol<Surgery>(o, "surgeries");
export async function createTheatre(ctx: Ctx, input: { code: string; name: string }) { await need(ctx, "hospital:create"); return rec(ctx, "theatres", { _id: newId(), ...v(z.object({ code: z.string().min(1), name: z.string().min(2) }).safeParse(input)) }, "theatre.create"); }

/** Overlap-free scheduling per theatre and day (serialised with a lock, like doctor appointments). */
export async function scheduleSurgery(ctx: Ctx, input: { theatreId: string; patientId: string; procedure: string; surgeonId: string; team?: string[]; start: Date; end: Date }): Promise<Surgery> {
  await need(ctx, "hospital:create");
  if (!(input.end > input.start)) throw new AppError("VALIDATION", "End must be after start");
  if (!(await tenantCol(ctx.orgId, "theatres").findOne({ _id: input.theatreId } as never))) throw new AppError("NOT_FOUND", "Theatre not found");
  if (!(await contactInfo(ctx, [input.patientId])).has(input.patientId)) throw new AppError("NOT_FOUND", "Patient not found");
  const key = `theatre:${input.theatreId}:${input.start.toISOString().slice(0, 10)}`;
  await precreateLock(ctx.orgId, key);
  return withTransaction(async (s) => {
    await bumpLock(ctx.orgId, key, s);
    const clash = await sx(ctx.orgId).count({ theatreId: input.theatreId, status: { $in: ["scheduled", "in_theatre", "recovery"] }, start: { $lt: input.end }, end: { $gt: input.start } } as never, s);
    if (clash) throw new AppError("CONFLICT", "Theatre is already booked for that time");
    const year = yearOf();
    const x: Surgery = { _id: newId(), number: docNo("OT", year, await nextSeq(ctx.orgId, `ot:${year}`, s)), ...input, team: input.team ?? [], status: "scheduled", checklist: CHECKLIST.map((item) => ({ item, done: false })), recovery: [], materials: [] };
    await sx(ctx.orgId).insertOne(x, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "surgery.schedule", resource: "surgeries", resourceId: x._id, after: { procedure: x.procedure, start: x.start } });
    return x;
  });
}
export async function completeChecklistItem(ctx: Ctx, surgeryId: string, index: number) {
  await need(ctx, "hospital:update");
  const r = await sx(ctx.orgId).updateOne({ _id: surgeryId, status: "scheduled", [`checklist.${index}.done`]: false } as never, { $set: { [`checklist.${index}.done`]: true, [`checklist.${index}.by`]: ctx.userId } } as never);
  if (r.matchedCount === 0) throw new AppError("CONFLICT", "Item not found or already completed");
}
/** Patient safety gate: every checklist item AND a granted surgical consent are required. Nothing can bypass this. */
export async function startSurgery(ctx: Ctx, surgeryId: string) {
  await need(ctx, "hospital:approve");
  const x = await sx(ctx.orgId).findOne({ _id: surgeryId } as never);
  if (!x) throw new AppError("NOT_FOUND", "Surgery not found");
  if (x.status !== "scheduled") throw new AppError("CONFLICT", `Surgery is ${x.status}`);
  if (x.checklist.some((c) => !c.done)) throw new AppError("CONFLICT", "The pre-operative checklist is incomplete");
  const p = await getPatient(ctx, x.patientId);
  if (!(p.consents as { type: string; granted: boolean }[]).some((c) => c.type === "surgery" && c.granted)) throw new AppError("CONFLICT", "No granted surgical consent is on file");
  await sx(ctx.orgId).updateOne({ _id: surgeryId, status: "scheduled" } as never, { $set: { status: "in_theatre" } } as never);
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "surgery.start", resource: "surgeries", resourceId: surgeryId }));
}
export async function recordSurgeryConsent(ctx: Ctx, patientId: string) {
  await need(ctx, "hospital:approve");
  await tenantCol(ctx.orgId, "patients").updateOne({ _id: patientId } as never, { $push: { consents: { type: "surgery", granted: true, at: new Date() } } } as never);
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "consent.surgery", resource: "patient", resourceId: patientId }));
}
export async function useTheatreMaterial(ctx: Ctx, input: { surgeryId: string; itemId: string; qty: number; locationId: string }) {
  await need(ctx, "hospital:update");
  return withTransaction(async (s) => {
    const x = await sx(ctx.orgId).findOne({ _id: input.surgeryId, status: { $in: ["in_theatre", "recovery"] } } as never, s);
    if (!x) throw new AppError("CONFLICT", "Materials can be recorded only during or after the procedure");
    const item = await getItem(ctx, input.itemId);
    const al = await allocateFefo(ctx, { itemId: item._id, locationId: input.locationId, qty: input.qty, refType: "surgery", refId: x._id }, s);
    const cost = allocationValue(al);
    await postJournalSystem(ctx, { date: new Date(), memo: `Theatre materials ${x.number}`, sourceRef: { type: "surgery_materials", id: x._id }, idempotencyKey: `otmat:${newId()}`,
      lines: [{ accountId: (await tenantCol<{ _id: string }>(ctx.orgId, "accounts").findOne({ code: "5300" } as never, s))!._id, debit: cost.toFixed(2) }, { accountId: (await accountBySystem(ctx.orgId, inventoryAccountSystem(item)))._id, credit: cost.toFixed(2) }] }, s);
    await sx(ctx.orgId).updateOne({ _id: x._id } as never, { $push: { materials: { itemId: item._id, qty: input.qty } } } as never, s);
    return cost;
  });
}
export async function moveToRecovery(ctx: Ctx, surgeryId: string, notes: string) {
  await need(ctx, "hospital:update");
  if (!notes.trim()) throw new AppError("VALIDATION", "Procedure notes required");
  const r = await sx(ctx.orgId).updateOne({ _id: surgeryId, status: "in_theatre" } as never, { $set: { status: "recovery", notes } } as never);
  if (r.matchedCount === 0) throw new AppError("CONFLICT", "Surgery is not in theatre");
}
export async function recordRecoveryObservation(ctx: Ctx, surgeryId: string, note: string) {
  await need(ctx, "hospital:update");
  const r = await sx(ctx.orgId).updateOne({ _id: surgeryId, status: "recovery" } as never, { $push: { recovery: { at: new Date(), by: ctx.userId, note } } } as never);
  if (r.matchedCount === 0) throw new AppError("CONFLICT", "Surgery is not in recovery");
}
/** Completion requires at least one recovery observation; creates the theatre charge once if a service is configured. */
export async function completeSurgery(ctx: Ctx, surgeryId: string) {
  await need(ctx, "hospital:approve");
  const c = await cfg(ctx);
  return withTransaction(async (s) => {
    const x = await sx(ctx.orgId).findOne({ _id: surgeryId } as never, s);
    if (!x) throw new AppError("NOT_FOUND", "Surgery not found");
    if (x.status !== "recovery") throw new AppError("CONFLICT", `Surgery is ${x.status}`);
    if (!x.recovery.length) throw new AppError("CONFLICT", "Record at least one recovery observation before completing");
    await sx(ctx.orgId).updateOne({ _id: surgeryId, status: "recovery" } as never, { $set: { status: "completed" } } as never, s);
    if (c.theatreServiceId) await createServiceCharge(ctx, { encounterId: x._id, patientId: x.patientId, serviceId: c.theatreServiceId, qty: 1, autoKey: `ot:${x._id}` }, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "surgery.complete", resource: "surgeries", resourceId: surgeryId });
  });
}
export async function cancelSurgery(ctx: Ctx, surgeryId: string, reason: string) {
  await need(ctx, "hospital:update");
  if (!reason.trim()) throw new AppError("VALIDATION", "Reason required");
  const r = await sx(ctx.orgId).updateOne({ _id: surgeryId, status: "scheduled" } as never, { $set: { status: "cancelled", cancelReason: reason } } as never);
  if (r.matchedCount === 0) throw new AppError("CONFLICT", "Only scheduled surgeries can be cancelled");
}
export async function listSurgeries(ctx: Ctx) { await need(ctx, "hospital:view"); return sx(ctx.orgId).find({} as never, { sort: { start: 1 }, limit: 300 }); }
export async function hospitalDashboard(ctx: Ctx) {
  await need(ctx, "hospital:view");
  const board = await bedBoard(ctx);
  const beds = board.flatMap((w) => w.beds);
  return { beds: beds.length, occupied: beds.filter((b) => b.status === "occupied").length, cleaning: beds.filter((b) => b.status === "cleaning").length, admitted: (await listAdmissions(ctx)).length, erWaiting: (await erQueue(ctx)).filter((e) => e.status === "waiting").length, upcomingSurgeries: (await listSurgeries(ctx)).filter((x) => x.status === "scheduled").length };
}
