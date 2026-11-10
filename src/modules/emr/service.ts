import type { ClientSession } from "mongodb";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { emit } from "@/core/outbox";
import { publish } from "@/core/bus";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { transitionAppointment } from "@/modules/appointments/service";
import type { Appointment, Staff } from "@/modules/appointments/schema";
import { markTokenStarted, markTokenDone } from "@/modules/queue/service";
import { getPatient } from "@/modules/patients/service";
import { ensureConsultationCharge } from "@/modules/billing/charges";
import { DiagnosisInput, Soap, VitalsInput, type Encounter, type Note } from "./schema";

const enc = (orgId: string) => tenantCol<Encounter>(orgId, "encounters");
const notes = (orgId: string) => tenantCol<Note>(orgId, "notes");
const OVERRIDE_ROLES = ["medical_director", "org_admin", "platform_super_admin"];

function validate<T>(r: { success: true; data: T } | { success: false; error: { message: string } }): T {
  if (!r.success) throw new AppError("VALIDATION", r.error.message);
  return r.data;
}

/** The clinician of record (or an override role) may act on an encounter. */
async function assertClinician(ctx: Ctx, doctorId: string, s?: ClientSession) {
  if (ctx.roles.some((r) => OVERRIDE_ROLES.includes(r))) return;
  const staff = await tenantCol<Staff & { userId?: string }>(ctx.orgId, "staff").findOne({ _id: doctorId } as never, s);
  if (!ctx.roles.includes("doctor") || (staff?.userId && staff.userId !== ctx.userId)) {
    throw new AppError("FORBIDDEN", "Only the assigned doctor can do this");
  }
}

async function loadEncounter(ctx: Ctx, id: string, s?: ClientSession): Promise<Encounter> {
  const e = await enc(ctx.orgId).findOne({ _id: id } as never, s);
  if (!e) throw new AppError("NOT_FOUND", "Encounter not found");
  return e;
}

export async function openEncounter(ctx: Ctx, appointmentId: string) {
  assertPermission(ctx, "emr:create");
  const existing = await enc(ctx.orgId).findOne({ appointmentId } as never);
  if (existing) {
    await assertClinician(ctx, existing.doctorId);
    return getWorkspace(ctx, existing._id);
  }
  const appt = await tenantCol<Appointment>(ctx.orgId, "appointments").findOne({ _id: appointmentId } as never);
  if (!appt) throw new AppError("NOT_FOUND", "Appointment not found");
  await assertClinician(ctx, appt.doctorId);

  let encId: string;
  try {
    encId = await withTransaction(async (s) => {
      await transitionAppointment(ctx, appointmentId, "in_consult", s);
      await markTokenStarted(ctx, appointmentId, s);
      const e: Encounter = {
        _id: newId(), appointmentId, patientId: appt.patientId, doctorId: appt.doctorId, branchId: appt.branchId,
        status: "open", openedAt: new Date(), openedBy: ctx.userId, vitals: [], diagnoses: [],
      };
      await enc(ctx.orgId).insertOne(e, s);
      const n: Note = {
        _id: newId(), encounterId: e._id, patientId: e.patientId, version: 1, status: "draft",
        soap: { s: "", o: "", a: "", p: "" }, authorId: ctx.userId, createdAt: new Date(),
      };
      await notes(ctx.orgId).insertOne(n, s);
      await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "encounter.open", resource: "encounter", resourceId: e._id, after: { appointmentId } });
      await emit(s, ctx.orgId, "encounter.opened", { encounterId: e._id });
      return e._id;
    });
  } catch (err) {
    // lost a race with a concurrent open: return the winner's encounter
    const won = await enc(ctx.orgId).findOne({ appointmentId } as never);
    if (err instanceof AppError && err.code === "CONFLICT" && won) return getWorkspace(ctx, won._id);
    throw err;
  }
  publish(ctx.orgId, { type: "queue.updated", branchId: appt.branchId, payload: { reason: "consult_started" } });
  return getWorkspace(ctx, encId);
}

/** Everything a clinician needs on one screen. Every call is audited. */
export async function getWorkspace(ctx: Ctx, encounterId: string) {
  assertPermission(ctx, "emr:view");
  const encounter = await loadEncounter(ctx, encounterId);
  const patient = await getPatient(ctx, encounter.patientId);
  const versions = await notes(ctx.orgId).find({ encounterId } as never, { sort: { version: 1 } });
  const note = [...versions].reverse().find((n) => n.status !== "superseded") ?? versions[versions.length - 1];
  await withTransaction((s) =>
    audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "emr.read", resource: "encounter", resourceId: encounterId }),
  );
  const warnings: string[] = [];
  if (!encounter.diagnoses.length) warnings.push("No diagnosis recorded");
  if (!encounter.vitals.length) warnings.push("No vital signs recorded");
  if (note?.status === "draft") warnings.push("Note is unsigned");
  return {
    encounter,
    patient,
    note,
    versions,
    warnings,
    alerts: { allergies: patient.allergies, medical: patient.alerts },
  };
}

async function loadNote(ctx: Ctx, noteId: string, s?: ClientSession): Promise<Note> {
  const n = await notes(ctx.orgId).findOne({ _id: noteId } as never, s);
  if (!n) throw new AppError("NOT_FOUND", "Note not found");
  return n;
}

export async function saveDraftNote(ctx: Ctx, noteId: string, soap: Soap) {
  assertPermission(ctx, "emr:update");
  const parsed = validate(Soap.safeParse(soap));
  const n = await loadNote(ctx, noteId);
  const res = await notes(ctx.orgId).updateOne({ _id: noteId, status: "draft" } as never, { $set: { soap: parsed } } as never);
  if (res.matchedCount === 0) throw new AppError("CONFLICT", `Note is ${n.status}; signed notes cannot be edited. Amend instead.`);
  await withTransaction((s) =>
    audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "note.draft_save", resource: "note", resourceId: noteId }),
  );
}

function assertAuthorOrDirector(ctx: Ctx, n: Note) {
  if (n.authorId !== ctx.userId && !ctx.roles.some((r) => OVERRIDE_ROLES.includes(r))) {
    throw new AppError("FORBIDDEN", "Only the note author or a medical director can sign");
  }
}

export async function signNote(ctx: Ctx, noteId: string) {
  assertPermission(ctx, "emr:approve");
  const n = await loadNote(ctx, noteId);
  assertAuthorOrDirector(ctx, n);
  if (!Object.values(n.soap).some((v) => v.trim())) throw new AppError("VALIDATION", "Cannot sign an empty note");
  return withTransaction(async (s) => {
    const res = await notes(ctx.orgId).updateOne(
      { _id: noteId, status: "draft" } as never,
      { $set: { status: "signed", signedAt: new Date(), signedBy: ctx.userId } } as never, s);
    if (res.matchedCount === 0) throw new AppError("CONFLICT", "Note is not a draft");
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "note.sign", resource: "note", resourceId: noteId, after: { version: n.version } });
    await emit(s, ctx.orgId, "note.signed", { noteId, encounterId: n.encounterId });
  });
}

/** Amendment never overwrites: v1 becomes `superseded` (content intact), v2 is created signed and linked. */
export async function amendNote(ctx: Ctx, noteId: string, soap: Soap, reason: string): Promise<Note> {
  assertPermission(ctx, "emr:approve");
  if (!reason.trim()) throw new AppError("VALIDATION", "Amendment reason required");
  const parsed = validate(Soap.safeParse(soap));
  return withTransaction(async (s) => {
    const old = await loadNote(ctx, noteId, s);
    assertAuthorOrDirector(ctx, old);
    const flip = await notes(ctx.orgId).updateOne({ _id: noteId, status: "signed" } as never, { $set: { status: "superseded" } } as never, s);
    if (flip.matchedCount === 0) throw new AppError("CONFLICT", "Only the current signed version can be amended");
    const v2: Note = {
      _id: newId(), encounterId: old.encounterId, patientId: old.patientId, version: old.version + 1, supersedes: old._id,
      status: "signed", soap: parsed, authorId: ctx.userId, signedAt: new Date(), signedBy: ctx.userId, amendReason: reason, createdAt: new Date(),
    };
    await notes(ctx.orgId).insertOne(v2, s);
    await audit(s, {
      orgId: ctx.orgId, actorId: ctx.userId, action: "note.amend", resource: "note", resourceId: v2._id,
      before: { noteId, soap: old.soap }, after: { soap: parsed, reason },
    });
    await emit(s, ctx.orgId, "note.amended", { noteId: v2._id, encounterId: old.encounterId });
    return v2;
  });
}

export async function recordVitals(ctx: Ctx, encounterId: string, input: VitalsInput) {
  assertPermission(ctx, "emr:update");
  const v = validate(VitalsInput.safeParse(input));
  await loadEncounter(ctx, encounterId);
  await withTransaction(async (s) => {
    await enc(ctx.orgId).updateOne({ _id: encounterId } as never, { $push: { vitals: { ...v, at: new Date(), by: ctx.userId } } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "vitals.record", resource: "encounter", resourceId: encounterId, after: v });
  });
}

export async function addDiagnosis(ctx: Ctx, encounterId: string, input: DiagnosisInput) {
  assertPermission(ctx, "emr:update");
  const d = validate(DiagnosisInput.safeParse(input));
  const e = await loadEncounter(ctx, encounterId);
  await assertClinician(ctx, e.doctorId);
  await withTransaction(async (s) => {
    await enc(ctx.orgId).updateOne({ _id: encounterId } as never, { $push: { diagnoses: { ...d, at: new Date(), by: ctx.userId } } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "diagnosis.add", resource: "encounter", resourceId: encounterId, after: d });
  });
}

/** Idempotent. Requires a signed note. Billing hooks attach here (see billing/charges). */
export async function completeEncounter(ctx: Ctx, encounterId: string): Promise<Encounter> {
  assertPermission(ctx, "emr:update");
  const e0 = await loadEncounter(ctx, encounterId);
  await assertClinician(ctx, e0.doctorId);
  if (e0.status === "completed") return e0;
  const out = await withTransaction(async (s) => {
    const e = await loadEncounter(ctx, encounterId, s);
    if (e.status === "completed") return e;
    const signed = await notes(ctx.orgId).count({ encounterId, status: "signed" } as never, s);
    if (!signed) throw new AppError("CONFLICT", "Sign the clinical note before completing the encounter");
    await transitionAppointment(ctx, e.appointmentId, "completed", s);
    await markTokenDone(ctx, e.appointmentId, s);
    await enc(ctx.orgId).updateOne({ _id: encounterId, status: "open" } as never, { $set: { status: "completed", completedAt: new Date() } } as never, s);
    await ensureConsultationCharge(ctx, e, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "encounter.complete", resource: "encounter", resourceId: encounterId });
    await emit(s, ctx.orgId, "encounter.completed", { encounterId });
    return { ...e, status: "completed" as const, completedAt: new Date() };
  });
  publish(ctx.orgId, { type: "queue.updated", branchId: e0.branchId, payload: { reason: "consult_done" } });
  return out;
}

export async function listPatientEncounters(ctx: Ctx, patientId: string) {
  assertPermission(ctx, "emr:view");
  return enc(ctx.orgId).find({ patientId } as never, { sort: { openedAt: -1 }, limit: 100 });
}

/** Encounter for an appointment, if one has been opened (used to link queue/appointment rows to the workspace). */
export async function findEncounterByAppointment(ctx: Ctx, appointmentId: string) {
  assertPermission(ctx, "emr:view");
  return enc(ctx.orgId).findOne({ appointmentId } as never);
}

/** Diagnosis codes only (no clinical narrative) for claim coding. */
export async function listEncounterDiagnoses(ctx: Ctx, encounterIds: string[]): Promise<Map<string, string[]>> {
  if (!ctx.permissions.includes("emr:view") && !ctx.permissions.includes("insurance:view")) throw new AppError("FORBIDDEN", "Missing permission emr:view");
  const rows = await enc(ctx.orgId).find({ _id: { $in: encounterIds } } as never);
  return new Map(rows.map((e) => [e._id, e.diagnoses.map((d) => d.code)]));
}

/** Minimal encounter facts for modules that attach orders/charges to an encounter. */
export async function getEncounterBrief(ctx: Ctx, encounterId: string) {
  if (!ctx.permissions.includes("emr:view") && !ctx.permissions.includes("pharmacy:view") && !ctx.permissions.includes("laboratory:view")) throw new AppError("FORBIDDEN", "Missing permission emr:view");
  const e = await loadEncounter(ctx, encounterId);
  const staff = await tenantCol<{ userId?: string }>(ctx.orgId, "staff").findOne({ _id: e.doctorId } as never);
  return { _id: e._id, patientId: e.patientId, doctorId: e.doctorId, doctorUserId: staff?.userId, branchId: e.branchId, status: e.status };
}
