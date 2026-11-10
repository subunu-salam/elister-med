import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { permissionsFor } from "@/core/rbac/roles";
import type { Ctx } from "@/core/rbac/authorize";
import { bookAppointment, cancelAppointment, listPatientAppointments, rescheduleAppointment, listDoctors } from "@/modules/appointments/service";
import { checkIn, listTodayTokens, estimateWaitMinutes } from "@/modules/queue/service";
import { listPatientInvoices } from "@/modules/billing/invoice";
import { listPatientLabOrders } from "@/modules/laboratory/service";
import { contactInfo } from "@/modules/patients/service";
import type { Appointment } from "@/modules/appointments/schema";

/**
 * Portal users are bound to exactly ONE patient record (ctx.patientId, set from their membership). Every function re-derives
 * the patient from the context, never from input, so one patient can never read or change another's data.
 */
function portal(ctx: Ctx): string {
  if (!ctx.roles.includes("patient_portal_user") || !ctx.patientId) throw new AppError("FORBIDDEN", "Patient portal access required");
  return ctx.patientId;
}
/** Narrow, explicit elevation used only for the patient's own record. Only these read/own-booking permissions can ever be added. */
const ELEVATABLE = new Set(["appointments:view", "appointments:create", "appointments:update", "billing:view", "patients:view", "queue:view", "laboratory:view"]);
const as = (ctx: Ctx, perms: string[]): Ctx => ({ ...ctx, permissions: [...new Set([...ctx.permissions, ...perms.filter((p) => ELEVATABLE.has(p))])] as Ctx["permissions"] });

export async function portalOverview(ctx: Ctx) {
  const pid = portal(ctx);
  const c = as(ctx, ["appointments:view", "billing:view", "patients:view"]);
  const appts = await listPatientAppointments(c, pid);
  const invs = await listPatientInvoices(c, pid);
  return {
    upcoming: appts.filter((a) => a.start > new Date() && ["booked", "checked_in"].includes(a.status)).map((a) => ({ id: a._id, start: a.start, doctorId: a.doctorId, status: a.status, checkInToken: a.checkInToken })),
    past: appts.filter((a) => a.start <= new Date()).slice(0, 10).map((a) => ({ id: a._id, start: a.start, status: a.status })),
    invoices: invs.map((i) => ({ id: i._id, number: i.number, total: i.total.toString(), balance: i.balance.toString(), status: i.status })),
  };
}
export async function portalDoctors(ctx: Ctx) { portal(ctx); return (await listDoctors(as(ctx, ["appointments:view"]))).map((d) => ({ id: d._id, name: d.name, specialty: d.specialty })); }

export async function portalBook(ctx: Ctx, input: { doctorId: string; start: Date; end: Date }): Promise<Appointment> {
  const pid = portal(ctx);
  const a = await bookAppointment(as(ctx, ["appointments:create"]), { patientId: pid, doctorId: input.doctorId, start: input.start, end: input.end, type: "consultation", notes: "Booked online" });
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "portal.book", resource: "appointment", resourceId: a._id }));
  return a;
}
async function own(ctx: Ctx, appointmentId: string) {
  const pid = portal(ctx);
  const a = (await listPatientAppointments(as(ctx, ["appointments:view"]), pid)).find((x) => x._id === appointmentId);
  if (!a) throw new AppError("NOT_FOUND", "Appointment not found");
  return a;
}
export async function portalReschedule(ctx: Ctx, appointmentId: string, start: Date, end: Date) { await own(ctx, appointmentId); return rescheduleAppointment(as(ctx, ["appointments:update"]), appointmentId, start, end); }
export async function portalCancel(ctx: Ctx, appointmentId: string, reason: string) { await own(ctx, appointmentId); return cancelAppointment(as(ctx, ["appointments:update"]), appointmentId, reason || "Cancelled by patient"); }

/** Only released lab orders, with results; draft/unverified results are never shown. */
export async function portalResults(ctx: Ctx) {
  const pid = portal(ctx);
  const orders = (await listPatientLabOrders(as(ctx, ["laboratory:view"]), pid)).filter((o) => o.status === "released");
  return orders.map((o) => ({ number: o.number, releasedAt: o.releasedAt, tests: o.tests.map((t) => ({ name: t.name, value: t.value, unit: t.unit, flag: t.flag })) }));
}

/** Position in today's queue and an estimate from real consult durations. Contains no other patient's data. */
export async function portalQueueStatus(ctx: Ctx) {
  const pid = portal(ctx);
  const c = as(ctx, ["queue:view"]);
  const mine = (await listTodayTokens(c)).find((t) => t.patientId === pid && ["waiting", "called", "in_consult"].includes(t.status));
  if (!mine) return null;
  return { number: mine.number, status: mine.status, estimatedWaitMinutes: mine.status === "waiting" ? await estimateWaitMinutes(c, mine.doctorId) : 0 };
}

/** Self-service intake: contact details and communication preferences. Self-reported allergies are stored separately and flagged unverified for staff review. */
export async function portalSubmitIntake(ctx: Ctx, input: { phone?: string; email?: string; address?: string; preferredLanguage?: "en" | "ar"; commPrefs?: { sms: boolean; email: boolean; whatsapp: boolean; marketing: boolean }; selfReportedAllergies?: string[]; consentToTreatment?: boolean }) {
  const pid = portal(ctx);
  const set: Record<string, unknown> = {};
  if (input.phone) { if (!/^\+?[0-9 ()-]{7,20}$/.test(input.phone)) throw new AppError("VALIDATION", "Invalid phone number"); set.phone = input.phone.replace(/[^\d+]/g, ""); }
  if (input.email) { if (!/^\S+@\S+\.\S+$/.test(input.email)) throw new AppError("VALIDATION", "Invalid email"); set.email = input.email; }
  if (input.address) set.address = input.address;
  if (input.preferredLanguage) set.preferredLanguage = input.preferredLanguage;
  if (input.commPrefs) set.commPrefs = input.commPrefs;
  await withTransaction(async (s) => {
    if (Object.keys(set).length) await tenantCol(ctx.orgId, "patients").updateOne({ _id: pid } as never, { $set: set } as never, s);
    if (input.consentToTreatment) await tenantCol(ctx.orgId, "patients").updateOne({ _id: pid } as never, { $push: { consents: { type: "treatment", granted: true, at: new Date() } } } as never, s);
    await tenantCol(ctx.orgId, "intake_forms").insertOne({ _id: newId(), patientId: pid, selfReportedAllergies: input.selfReportedAllergies ?? [], verified: false, at: new Date() } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "portal.intake", resource: "patient", resourceId: pid, after: { fields: Object.keys(set) } });
  });
}

/** Staff review of self-reported allergies (never auto-merged into the clinical allergy list). */
export async function pendingIntake(ctx: Ctx) {
  if (!ctx.permissions.includes("patients:update")) throw new AppError("FORBIDDEN", "Missing permission patients:update");
  return tenantCol<{ _id: string; patientId: string; selfReportedAllergies: string[]; verified: boolean; at: Date }>(ctx.orgId, "intake_forms").find({ verified: false } as never, { sort: { at: 1 }, limit: 200 });
}

// ================= Kiosk / QR check-in =================
/** Self check-in with the appointment's QR token. Only today's booked appointments qualify. Returns the token number and nothing personal. */
export async function kioskCheckIn(orgId: string, branchId: string, qrToken: string): Promise<{ tokenNumber: number }> {
  const sys: Ctx = { userId: "kiosk", orgId, branchId, roles: ["receptionist"], permissions: permissionsFor(["receptionist"]) };
  const a = await tenantCol<Appointment>(orgId, "appointments").findOne({ checkInToken: qrToken } as never);
  if (!a) throw new AppError("NOT_FOUND", "Appointment not found");
  const day = (d: Date) => new Date(d.getTime() + 4 * 3600_000).toISOString().slice(0, 10);
  if (day(a.start) !== day(new Date())) throw new AppError("CONFLICT", "This appointment is not today");
  const t = await checkIn(sys, a._id);
  return { tokenNumber: t.number };
}
void contactInfo;
