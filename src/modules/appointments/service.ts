import { z } from "zod";
import { randomBytes } from "node:crypto";
import type { ClientSession } from "mongodb";
import { tenantCol, withTransaction } from "@/core/db";
import { precreateLock as preLock, bumpLock } from "@/core/locks";
import { audit } from "@/core/audit";
import { emit } from "@/core/outbox";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { dubaiParts } from "@/core/time";
import { assertSlotFree } from "./availability";
import { TRANSITIONS, type Appointment, type ApptStatus } from "./schema";

const COL = "appointments";

const BookInput = z.object({
  patientId: z.string().min(1),
  doctorId: z.string().min(1),
  start: z.coerce.date(),
  end: z.coerce.date(),
  type: z.string().default("consultation"),
  notes: z.string().optional(),
});
export type BookInput = z.input<typeof BookInput>;

const lockKey = (doctorId: string, start: Date) => `doctor-day:${doctorId}:${dubaiParts(start).ymd}`;
/** Serialises concurrent bookings for one doctor-day (see core/locks). */
const lockDoctorDay = (ctx: Ctx, doctorId: string, start: Date, s: ClientSession) => bumpLock(ctx.orgId, lockKey(doctorId, start), s);
const precreateLock = (ctx: Ctx, doctorId: string, start: Date) => preLock(ctx.orgId, lockKey(doctorId, start));

export async function bookAppointment(ctx: Ctx, input: BookInput): Promise<Appointment> {
  assertPermission(ctx, "appointments:create");
  const p = BookInput.safeParse(input);
  if (!p.success) throw new AppError("VALIDATION", p.error.message);
  const d = p.data;
  if (!(await tenantCol(ctx.orgId, "patients").findOne({ _id: d.patientId } as never))) {
    throw new AppError("NOT_FOUND", "Patient not found");
  }
  if (!(await tenantCol(ctx.orgId, "staff").findOne({ _id: d.doctorId } as never))) {
    throw new AppError("NOT_FOUND", "Doctor not found");
  }
  await precreateLock(ctx, d.doctorId, d.start);

  return withTransaction(async (s) => {
    await lockDoctorDay(ctx, d.doctorId, d.start, s);
    const doc = await assertSlotFree(ctx.orgId, d.doctorId, d.start, d.end, s);
    const a: Appointment = {
      _id: newId(),
      patientId: d.patientId,
      doctorId: d.doctorId,
      branchId: doc.branchId,
      start: d.start,
      end: d.end,
      type: d.type,
      checkInToken: randomBytes(9).toString("base64url"),
      status: "booked",
      notes: d.notes,
      createdAt: new Date(),
      createdBy: ctx.userId,
      history: [{ status: "booked", at: new Date(), by: ctx.userId }],
    };
    await tenantCol<Appointment>(ctx.orgId, COL).insertOne(a, s);
    await audit(s, {
      orgId: ctx.orgId, actorId: ctx.userId, action: "appointment.book", resource: "appointment", resourceId: a._id,
      after: { doctorId: a.doctorId, start: a.start },
    });
    await emit(s, ctx.orgId, "appointment.booked", { appointmentId: a._id });
    return a;
  });
}

async function load(ctx: Ctx, id: string, s: ClientSession): Promise<Appointment> {
  const a = await tenantCol<Appointment>(ctx.orgId, COL).findOne({ _id: id } as never, s);
  if (!a) throw new AppError("NOT_FOUND", "Appointment not found");
  return a;
}

/** Single place that enforces the state machine. Other modules (queue, EMR) call this. */
export async function transitionAppointment(
  ctx: Ctx, id: string, to: ApptStatus, s: ClientSession, reason?: string,
): Promise<Appointment> {
  const a = await load(ctx, id, s);
  if (!TRANSITIONS[a.status].includes(to)) throw new AppError("CONFLICT", `Invalid transition ${a.status} -> ${to}`);
  const res = await tenantCol<Appointment>(ctx.orgId, COL).updateOne(
    { _id: id, status: a.status } as never,
    { $set: { status: to }, $push: { history: { status: to, at: new Date(), by: ctx.userId, reason } } } as never,
    s,
  );
  if (res.matchedCount === 0) throw new AppError("CONFLICT", "Appointment changed concurrently");
  await audit(s, {
    orgId: ctx.orgId, actorId: ctx.userId, action: `appointment.${to}`, resource: "appointment", resourceId: id,
    before: { status: a.status }, after: { status: to, reason },
  });
  await emit(s, ctx.orgId, `appointment.${to}`, { appointmentId: id });
  return { ...a, status: to };
}

export async function cancelAppointment(ctx: Ctx, id: string, reason: string) {
  assertPermission(ctx, "appointments:update");
  if (!reason.trim()) throw new AppError("VALIDATION", "Reason required");
  return withTransaction((s) => transitionAppointment(ctx, id, "cancelled", s, reason));
}

export async function markNoShow(ctx: Ctx, id: string) {
  assertPermission(ctx, "appointments:update");
  return withTransaction((s) => transitionAppointment(ctx, id, "no_show", s));
}

export async function rescheduleAppointment(
  ctx: Ctx, id: string, start: Date, end: Date, doctorId?: string,
): Promise<Appointment> {
  assertPermission(ctx, "appointments:update");
  const cur = await tenantCol<Appointment>(ctx.orgId, COL).findOne({ _id: id } as never);
  if (!cur) throw new AppError("NOT_FOUND", "Appointment not found");
  const target = doctorId ?? cur.doctorId;
  await precreateLock(ctx, target, start);
  return withTransaction(async (s) => {
    await lockDoctorDay(ctx, target, start, s);
    const a = await load(ctx, id, s);
    if (a.status !== "booked") throw new AppError("CONFLICT", "Only booked appointments can be rescheduled");
    const doc = await assertSlotFree(ctx.orgId, target, start, end, s, id);
    await tenantCol<Appointment>(ctx.orgId, COL).updateOne(
      { _id: id } as never,
      {
        $set: { start, end, doctorId: target, branchId: doc.branchId },
        $push: { history: { status: a.status, at: new Date(), by: ctx.userId, reason: "rescheduled" } },
      } as never,
      s,
    );
    await audit(s, {
      orgId: ctx.orgId, actorId: ctx.userId, action: "appointment.reschedule", resource: "appointment", resourceId: id,
      before: { start: a.start, doctorId: a.doctorId }, after: { start, doctorId: target },
    });
    await emit(s, ctx.orgId, "appointment.rescheduled", { appointmentId: id });
    return { ...a, start, end, doctorId: target };
  });
}

export async function listAppointments(
  ctx: Ctx, f: { from: Date; to: Date; doctorId?: string; branchId?: string },
) {
  assertPermission(ctx, "appointments:view");
  return tenantCol<Appointment>(ctx.orgId, COL).find(
    {
      start: { $gte: f.from, $lt: f.to },
      ...(f.doctorId ? { doctorId: f.doctorId } : {}),
      ...(f.branchId ? { branchId: f.branchId } : {}),
    } as never,
    { sort: { start: 1 }, limit: 500 },
  );
}

export async function listPatientAppointments(ctx: Ctx, patientId: string) {
  assertPermission(ctx, "appointments:view");
  return tenantCol<Appointment>(ctx.orgId, COL).find({ patientId } as never, { sort: { start: -1 }, limit: 100 });
}

export async function listDoctors(ctx: Ctx) {
  assertPermission(ctx, "appointments:view");
  return tenantCol<{ _id: string; name: string; nameAr?: string; specialty?: string; userId?: string; slotMinutes: number; workStart: string; workEnd: string; workDays: number[] }>(ctx.orgId, "staff").find({ active: true, role: "doctor" } as never, { sort: { name: 1 } });
}

export async function getAppointment(ctx: Ctx, id: string) {
  assertPermission(ctx, "appointments:view");
  const a = await tenantCol<Appointment>(ctx.orgId, COL).findOne({ _id: id } as never);
  if (!a) throw new AppError("NOT_FOUND", "Appointment not found");
  return a;
}
