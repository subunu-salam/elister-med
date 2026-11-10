import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { contactInfo, createPatient, listContactIds, type ContactInfo } from "@/modules/patients/service";
import type { PatientInput } from "@/modules/patients/schema";
import { listAppointments } from "@/modules/appointments/service";

const v = <T>(r: { success: true; data: T } | { success: false; error: { message: string } }): T => { if (!r.success) throw new AppError("VALIDATION", r.error.message); return r.data; };

// ---------- Enquiries ----------
export type Enquiry = { _id: string; name: string; phone: string; channel: string; source: string; interest?: string; status: "new" | "contacted" | "converted" | "lost"; patientId?: string; notes: { at: Date; by: string; text: string }[]; createdAt: Date; createdBy: string };
const enq = (o: string) => tenantCol<Enquiry>(o, "enquiries");

export async function createEnquiry(ctx: Ctx, input: { name: string; phone: string; channel: string; source: string; interest?: string; note?: string }): Promise<Enquiry> {
  assertPermission(ctx, "crm:create");
  const d = v(z.object({ name: z.string().min(2), phone: z.string().min(7), channel: z.string().min(2), source: z.string().min(2), interest: z.string().optional(), note: z.string().optional() }).safeParse(input));
  const e: Enquiry = { _id: newId(), name: d.name, phone: d.phone, channel: d.channel, source: d.source, interest: d.interest, status: "new", notes: d.note ? [{ at: new Date(), by: ctx.userId, text: d.note }] : [], createdAt: new Date(), createdBy: ctx.userId };
  await withTransaction(async (s) => { await enq(ctx.orgId).insertOne(e, s); await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "enquiry.create", resource: "enquiry", resourceId: e._id }); });
  return e;
}
export async function updateEnquiry(ctx: Ctx, id: string, patch: { status?: Enquiry["status"]; note?: string }) {
  assertPermission(ctx, "crm:update");
  const res = await enq(ctx.orgId).updateOne({ _id: id, status: { $nin: ["converted"] } } as never, { ...(patch.status ? { $set: { status: patch.status } } : {}), ...(patch.note ? { $push: { notes: { at: new Date(), by: ctx.userId, text: patch.note } } } : {}) } as never);
  if (res.matchedCount === 0) throw new AppError("CONFLICT", "Enquiry not found or already converted");
}
/** New patient onboarding from an enquiry: registers the patient (with the enquiry source as referral source) and closes the enquiry. */
export async function convertEnquiry(ctx: Ctx, id: string, patient: PatientInput): Promise<{ patientId: string }> {
  assertPermission(ctx, "crm:update");
  const e = await enq(ctx.orgId).findOne({ _id: id } as never);
  if (!e) throw new AppError("NOT_FOUND", "Enquiry not found");
  if (e.status === "converted") throw new AppError("CONFLICT", "Enquiry already converted");
  const p = await createPatient(ctx, { ...patient, referralSource: patient.referralSource ?? e.source });
  await enq(ctx.orgId).updateOne({ _id: id } as never, { $set: { status: "converted", patientId: p._id } } as never);
  return { patientId: p._id };
}
export async function listEnquiries(ctx: Ctx) { assertPermission(ctx, "crm:view"); return enq(ctx.orgId).find({} as never, { sort: { createdAt: -1 }, limit: 200 }); }

// ---------- Follow-ups (reminders, missed appointments, chronic care) ----------
export type FollowUp = { _id: string; patientId: string; kind: "follow_up" | "missed_appointment" | "chronic_care" | "recall"; dueAt: Date; note?: string; status: "open" | "done"; dedupeKey?: string; createdBy: string; doneBy?: string };
const fus = (o: string) => tenantCol<FollowUp>(o, "follow_ups");

export async function createFollowUp(ctx: Ctx, input: { patientId: string; kind: FollowUp["kind"]; dueAt: Date; note?: string; dedupeKey?: string }): Promise<FollowUp> {
  assertPermission(ctx, "crm:create");
  if (input.dedupeKey) { const p = await fus(ctx.orgId).findOne({ dedupeKey: input.dedupeKey } as never); if (p) return p; }
  if (!(await contactInfo(ctx, [input.patientId])).has(input.patientId)) throw new AppError("NOT_FOUND", "Patient not found");
  const f: FollowUp = { _id: newId(), ...input, status: "open", createdBy: ctx.userId };
  await fus(ctx.orgId).insertOne(f);
  return f;
}
export async function completeFollowUp(ctx: Ctx, id: string) {
  assertPermission(ctx, "crm:update");
  const r = await fus(ctx.orgId).updateOne({ _id: id, status: "open" } as never, { $set: { status: "done", doneBy: ctx.userId } } as never);
  if (r.matchedCount === 0) throw new AppError("CONFLICT", "Follow-up not found or already done");
}
export async function listDueFollowUps(ctx: Ctx, upTo = new Date()) { assertPermission(ctx, "crm:view"); return fus(ctx.orgId).find({ status: "open", dueAt: { $lte: upTo } } as never, { sort: { dueAt: 1 }, limit: 300 }); }

/** One follow-up task per no-show in the last `days` days (idempotent). */
export async function generateMissedAppointmentFollowUps(ctx: Ctx, days = 14): Promise<number> {
  assertPermission(ctx, "crm:create");
  const appts = (await listAppointments(ctx, { from: new Date(Date.now() - days * 86400000), to: new Date() })).filter((a) => a.status === "no_show");
  let n = 0;
  for (const a of appts) {
    const before = await fus(ctx.orgId).findOne({ dedupeKey: `noshow:${a._id}` } as never);
    await createFollowUp(ctx, { patientId: a.patientId, kind: "missed_appointment", dueAt: new Date(), note: "Missed appointment: contact the patient to rebook", dedupeKey: `noshow:${a._id}` });
    if (!before) n++;
  }
  return n;
}

// ---------- Recall campaigns ----------
export type Campaign = { _id: string; name: string; kind: "recall" | "chronic" | "marketing"; channel: "sms" | "email" | "whatsapp"; lastVisitBeforeDays: number; status: "draft" | "active"; createdBy: string; createdAt: Date };
export async function createCampaign(ctx: Ctx, input: { name: string; kind: Campaign["kind"]; channel: Campaign["channel"]; lastVisitBeforeDays: number }): Promise<Campaign> {
  assertPermission(ctx, "crm:create");
  const d = v(z.object({ name: z.string().min(3), kind: z.enum(["recall", "chronic", "marketing"]), channel: z.enum(["sms", "email", "whatsapp"]), lastVisitBeforeDays: z.number().int().min(1).max(3650) }).safeParse(input));
  const c: Campaign = { _id: newId(), ...d, status: "draft", createdBy: ctx.userId, createdAt: new Date() };
  await tenantCol<Campaign>(ctx.orgId, "campaigns").insertOne(c);
  return c;
}
export type RecallCandidate = Pick<ContactInfo, "id" | "fullName" | "phone" | "preferredLanguage"> & { lastVisit: Date | null };

/**
 * Audience = patients whose last completed visit is older than the threshold AND who agreed to the channel
 * (marketing campaigns additionally need explicit marketing consent). Output is contact data only: no diagnoses, no results.
 */
export async function buildRecallList(ctx: Ctx, campaignId: string): Promise<{ candidates: RecallCandidate[]; excludedNoConsent: number }> {
  assertPermission(ctx, "crm:view");
  const camp = await tenantCol<Campaign>(ctx.orgId, "campaigns").findOne({ _id: campaignId } as never);
  if (!camp) throw new AppError("NOT_FOUND", "Campaign not found");
  const cutoff = new Date(Date.now() - camp.lastVisitBeforeDays * 86400000);
  const last = new Map<string, Date>();
  for (const a of await listAppointments(ctx, { from: new Date(0), to: new Date() })) if (a.status === "completed" && (!last.has(a.patientId) || a.start > last.get(a.patientId)!)) last.set(a.patientId, a.start);
  const contacts = await contactInfo(ctx, await listContactIds(ctx));
  const candidates: RecallCandidate[] = [];
  let excluded = 0;
  for (const [id, c] of contacts) {
    const lv = last.get(id) ?? null;
    if (lv && lv > cutoff) continue;
    if (!lv && camp.kind !== "marketing") continue; // care recall needs a prior visit
    const channelOk = c.commPrefs[camp.channel === "email" ? "email" : camp.channel];
    const marketingOk = camp.kind !== "marketing" || c.commPrefs.marketing;
    if (!channelOk || !marketingOk) { excluded++; continue; }
    candidates.push({ id, fullName: c.fullName, phone: c.phone, preferredLanguage: c.preferredLanguage, lastVisit: lv });
  }
  return { candidates, excludedNoConsent: excluded };
}

// ---------- Feedback, complaints, surveys ----------
export type Feedback = { _id: string; patientId?: string; appointmentId?: string; rating: number; nps?: number; comment?: string; at: Date; by: string };
export async function submitFeedback(ctx: Ctx, input: { patientId?: string; appointmentId?: string; rating: number; nps?: number; comment?: string }): Promise<Feedback> {
  assertPermission(ctx, "crm:create");
  const d = v(z.object({ patientId: z.string().optional(), appointmentId: z.string().optional(), rating: z.number().int().min(1).max(5), nps: z.number().int().min(0).max(10).optional(), comment: z.string().max(2000).optional() }).safeParse(input));
  const f: Feedback = { _id: newId(), ...d, at: new Date(), by: ctx.userId };
  await tenantCol<Feedback>(ctx.orgId, "feedback").insertOne(f);
  return f;
}
export async function satisfactionSummary(ctx: Ctx) {
  assertPermission(ctx, "crm:view");
  const all = await tenantCol<Feedback>(ctx.orgId, "feedback").find({} as never, { limit: 100000 });
  const ratings = all.map((f) => f.rating), nps = all.filter((f) => f.nps !== undefined).map((f) => f.nps!);
  const pct = (n: number) => (nps.length ? (n / nps.length) * 100 : 0);
  return {
    responses: all.length, avgRating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : 0,
    nps: nps.length ? pct(nps.filter((x) => x >= 9).length) - pct(nps.filter((x) => x <= 6).length) : null, npsResponses: nps.length,
  };
}

export type Complaint = { _id: string; patientId?: string; category: string; description: string; status: "open" | "investigating" | "resolved"; assignedTo?: string; resolution?: string; openedAt: Date; resolvedAt?: Date; openedBy: string };
const comps = (o: string) => tenantCol<Complaint>(o, "complaints");
export async function fileComplaint(ctx: Ctx, input: { patientId?: string; category: string; description: string }): Promise<Complaint> {
  assertPermission(ctx, "crm:create");
  const d = v(z.object({ patientId: z.string().optional(), category: z.string().min(2), description: z.string().min(10) }).safeParse(input));
  const c: Complaint = { _id: newId(), ...d, status: "open", openedAt: new Date(), openedBy: ctx.userId };
  await withTransaction(async (s) => { await comps(ctx.orgId).insertOne(c, s); await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "complaint.open", resource: "complaint", resourceId: c._id }); });
  return c;
}
export async function progressComplaint(ctx: Ctx, id: string, to: "investigating" | "resolved", opts: { assignedTo?: string; resolution?: string } = {}) {
  assertPermission(ctx, "crm:update");
  if (to === "resolved" && !opts.resolution?.trim()) throw new AppError("VALIDATION", "A resolution is required to close a complaint");
  const from = to === "investigating" ? ["open"] : ["open", "investigating"];
  const r = await comps(ctx.orgId).updateOne({ _id: id, status: { $in: from } } as never, { $set: { status: to, ...(opts.assignedTo ? { assignedTo: opts.assignedTo } : {}), ...(opts.resolution ? { resolution: opts.resolution, resolvedAt: new Date() } : {}) } } as never);
  if (r.matchedCount === 0) throw new AppError("CONFLICT", "Complaint not found or cannot move to that state");
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: `complaint.${to}`, resource: "complaint", resourceId: id }));
}
export async function listComplaints(ctx: Ctx) { assertPermission(ctx, "crm:view"); return comps(ctx.orgId).find({} as never, { sort: { openedAt: -1 }, limit: 200 }); }

/** Registrations and enquiry conversion by source. */
export async function referralAnalysis(ctx: Ctx) {
  assertPermission(ctx, "crm:view");
  const contacts = await contactInfo(ctx, await listContactIds(ctx));
  const bySource = new Map<string, { patients: number; enquiries: number; converted: number }>();
  const row = (k: string) => bySource.get(k) ?? { patients: 0, enquiries: 0, converted: 0 };
  for (const c of contacts.values()) { const k = c.referralSource ?? "unknown"; bySource.set(k, { ...row(k), patients: row(k).patients + 1 }); }
  for (const e of await listEnquiries(ctx)) { const r = row(e.source); bySource.set(e.source, { ...r, enquiries: r.enquiries + 1, converted: r.converted + (e.status === "converted" ? 1 : 0) }); }
  return [...bySource].map(([source, r]) => ({ source, ...r, conversionPct: r.enquiries ? (r.converted / r.enquiries) * 100 : null })).sort((a, b) => b.patients - a.patients);
}
