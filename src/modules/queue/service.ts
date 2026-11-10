import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { emit } from "@/core/outbox";
import { publish } from "@/core/bus";
import { nextSeq } from "@/core/counters";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { dubaiDayRange, dubaiParts } from "@/core/time";
import { transitionAppointment } from "@/modules/appointments/service";
import type { Staff } from "@/modules/appointments/schema";

export type TokenStatus = "waiting" | "called" | "in_consult" | "done" | "skipped";
export type Token = {
  _id: string; appointmentId: string; patientId: string; doctorId: string; branchId: string;
  day: string; number: number; priority: number; status: TokenStatus;
  checkedInAt: Date; calledAt?: Date; startedAt?: Date; completedAt?: Date;
};

const COL = "queue_tokens";
const tokens = (orgId: string) => tenantCol<Token>(orgId, COL);

function notify(ctx: Ctx, branchId: string, reason: string) {
  publish(ctx.orgId, { type: "queue.updated", branchId, payload: { reason } });
}

export async function checkIn(ctx: Ctx, appointmentId: string, opts: { priority?: number } = {}): Promise<Token> {
  assertPermission(ctx, "queue:create");
  const token = await withTransaction(async (s) => {
    const appt = await transitionAppointment(ctx, appointmentId, "checked_in", s);
    const day = dubaiParts(new Date()).ymd;
    const number = await nextSeq(ctx.orgId, `token:${appt.branchId}:${day}`, s);
    const t: Token = {
      _id: newId(), appointmentId, patientId: appt.patientId, doctorId: appt.doctorId, branchId: appt.branchId,
      day, number, priority: opts.priority ?? 0, status: "waiting", checkedInAt: new Date(),
    };
    await tokens(ctx.orgId).insertOne(t, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "queue.checkin", resource: "queue_token", resourceId: t._id, after: { number, appointmentId } });
    await emit(s, ctx.orgId, "queue.updated", { tokenId: t._id });
    return t;
  });
  notify(ctx, token.branchId, "checkin");
  return token;
}

/** Atomically claims the next waiting token for a doctor (priority desc, then token number). */
export async function callNext(ctx: Ctx, doctorId: string): Promise<Token | null> {
  assertPermission(ctx, "queue:update");
  const { start } = dubaiDayRange(new Date());
  const t = await tokens(ctx.orgId).findOneAndUpdate(
    { doctorId, status: "waiting", checkedInAt: { $gte: start } } as never,
    { $set: { status: "called", calledAt: new Date() } } as never,
    { sort: { priority: -1, number: 1 } },
  );
  if (t) notify(ctx, t.branchId, "called");
  return t;
}

export async function skipToken(ctx: Ctx, tokenId: string): Promise<void> {
  assertPermission(ctx, "queue:update");
  const t = await tokens(ctx.orgId).findOneAndUpdate(
    { _id: tokenId, status: { $in: ["waiting", "called"] } } as never,
    { $set: { status: "skipped" } } as never,
  );
  if (!t) throw new AppError("CONFLICT", "Token cannot be skipped");
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "queue.skip", resource: "queue_token", resourceId: tokenId }));
  notify(ctx, t.branchId, "skipped");
}

/** Used by the encounter module when a consult starts / ends. Runs inside the caller's txn. */
export async function markTokenStarted(ctx: Ctx, appointmentId: string, s: import("mongodb").ClientSession) {
  await tokens(ctx.orgId).updateOne({ appointmentId } as never, { $set: { status: "in_consult", startedAt: new Date() } } as never, s);
}
export async function markTokenDone(ctx: Ctx, appointmentId: string, s: import("mongodb").ClientSession) {
  await tokens(ctx.orgId).updateOne({ appointmentId } as never, { $set: { status: "done", completedAt: new Date() } } as never, s);
}

/** Minutes until a newly arriving patient would be seen: waiting count x recent actual consult length. */
export async function estimateWaitMinutes(ctx: Ctx, doctorId: string): Promise<number> {
  assertPermission(ctx, "queue:view");
  const { start } = dubaiDayRange(new Date());
  const waiting = await tokens(ctx.orgId).count({ doctorId, status: "waiting", checkedInAt: { $gte: start } } as never);
  if (waiting === 0) return 0;
  const recent = await tokens(ctx.orgId).find({ doctorId, status: "done", startedAt: { $exists: true }, completedAt: { $exists: true } } as never, { sort: { completedAt: -1 }, limit: 20 });
  let avg: number;
  if (recent.length) {
    avg = recent.reduce((a, t) => a + (t.completedAt!.getTime() - t.startedAt!.getTime()) / 60000, 0) / recent.length;
  } else {
    const doc = await tenantCol<Staff>(ctx.orgId, "staff").findOne({ _id: doctorId } as never);
    avg = doc?.slotMinutes ?? 15;
  }
  return Math.round(waiting * avg);
}

export type BoardRow = { number: number; status: TokenStatus; doctorLabel: string };

/** Payload for public screens. Deliberately contains no patient identifiers. */
export async function publicBoard(orgId: string, branchId: string): Promise<BoardRow[]> {
  const { start } = dubaiDayRange(new Date());
  const rows = await tokens(orgId).find(
    { branchId, status: { $in: ["waiting", "called", "in_consult"] }, checkedInAt: { $gte: start } } as never,
    { sort: { number: 1 }, limit: 100 },
  );
  const staff = await tenantCol<Staff>(orgId, "staff").find({ _id: { $in: [...new Set(rows.map((r) => r.doctorId))] } } as never);
  const label = new Map(staff.map((d) => [d._id, d.name]));
  return rows.map((r) => ({ number: r.number, status: r.status, doctorLabel: label.get(r.doctorId) ?? "Doctor" }));
}

/** Staff view of today's queue for a branch (includes patient ids; names resolved by the caller). */
export async function listTodayTokens(ctx: Ctx, branchId?: string): Promise<Token[]> {
  assertPermission(ctx, "queue:view");
  const { start } = dubaiDayRange(new Date());
  return tokens(ctx.orgId).find(
    { checkedInAt: { $gte: start }, ...(branchId ? { branchId } : {}) } as never,
    { sort: { number: 1 }, limit: 500 },
  );
}
