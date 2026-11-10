import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { emit } from "@/core/outbox";
import { nextSeq } from "@/core/counters";
import { notifyUser } from "@/core/notify";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { docNo, yearOf } from "@/modules/billing/invoice";
import { createServiceCharge } from "@/modules/billing/charges";
import { getEncounterBrief } from "@/modules/emr/service";

export type RadOrder = {
  _id: string; number: string; encounterId: string; patientId: string; doctorId: string; doctorUserId?: string; modality: string; study: string; serviceId?: string;
  status: "ordered" | "scheduled" | "performed" | "reported" | "released" | "cancelled"; scheduledAt?: Date; report?: { findings: string; impression: string; by: string; at: Date };
  verifiedBy?: string; pacsRef?: string; orderedAt: Date; orderedBy: string; releasedAt?: Date;
};
const orders = (o: string) => tenantCol<RadOrder>(o, "rad_orders");

/**
 * Orders, scheduling, reports and release. Image viewing and DICOM exchange are deliberately NOT implemented:
 * a `pacsRef` string links to an external PACS. A basic viewer is not a substitute for validated diagnostic software.
 */
export async function orderImaging(ctx: Ctx, input: { encounterId: string; modality: string; study: string; serviceId?: string }): Promise<RadOrder> {
  assertPermission(ctx, "radiology:create");
  const d = z.object({ encounterId: z.string(), modality: z.enum(["XR", "US", "CT", "MR", "MG", "DX", "OTHER"]), study: z.string().min(2), serviceId: z.string().optional() }).safeParse(input);
  if (!d.success) throw new AppError("VALIDATION", d.error.message);
  const enc = await getEncounterBrief(ctx, d.data.encounterId);
  return withTransaction(async (s) => {
    const year = yearOf();
    const o: RadOrder = { _id: newId(), number: docNo("RAD", year, await nextSeq(ctx.orgId, `rad:${year}`, s)), encounterId: enc._id, patientId: enc.patientId, doctorId: enc.doctorId, doctorUserId: enc.doctorUserId, modality: d.data.modality, study: d.data.study, serviceId: d.data.serviceId, status: "ordered", orderedAt: new Date(), orderedBy: ctx.userId };
    await orders(ctx.orgId).insertOne(o, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "rad.order", resource: "rad_order", resourceId: o._id, after: { number: o.number, study: o.study } });
    await emit(s, ctx.orgId, "rad.ordered", { orderId: o._id });
    return o;
  });
}

async function move(ctx: Ctx, id: string, from: RadOrder["status"][], set: Record<string, unknown>, action: string): Promise<RadOrder> {
  return withTransaction(async (s) => {
    const o = await orders(ctx.orgId).findOne({ _id: id } as never, s);
    if (!o) throw new AppError("NOT_FOUND", "Imaging order not found");
    if (!from.includes(o.status)) throw new AppError("CONFLICT", `Order is ${o.status}`);
    await orders(ctx.orgId).updateOne({ _id: id, status: o.status } as never, { $set: set } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action, resource: "rad_order", resourceId: id, after: set });
    return { ...o, ...(set as object) } as RadOrder;
  });
}

export async function scheduleImaging(ctx: Ctx, id: string, when: Date) {
  assertPermission(ctx, "radiology:update");
  if (when.getTime() < Date.now() - 3600_000) throw new AppError("VALIDATION", "Cannot schedule in the past");
  return move(ctx, id, ["ordered", "scheduled"], { status: "scheduled", scheduledAt: when }, "rad.schedule");
}
export async function markPerformed(ctx: Ctx, id: string, pacsRef?: string) {
  assertPermission(ctx, "radiology:update");
  return move(ctx, id, ["ordered", "scheduled"], { status: "performed", ...(pacsRef ? { pacsRef } : {}) }, "rad.perform");
}
export async function writeReport(ctx: Ctx, id: string, r: { findings: string; impression: string }) {
  assertPermission(ctx, "radiology:create");
  if (!r.findings.trim() || !r.impression.trim()) throw new AppError("VALIDATION", "Findings and impression are required");
  return move(ctx, id, ["performed", "reported"], { status: "reported", report: { ...r, by: ctx.userId, at: new Date() } }, "rad.report");
}

/** Radiologist review: the report author cannot also release it unless they are the reporting radiologist signing off their own final report is disallowed here (second reader). */
export async function releaseReport(ctx: Ctx, id: string): Promise<RadOrder> {
  assertPermission(ctx, "radiology:approve");
  return withTransaction(async (s) => {
    const o = await orders(ctx.orgId).findOne({ _id: id } as never, s);
    if (!o) throw new AppError("NOT_FOUND", "Imaging order not found");
    if (o.status !== "reported" || !o.report) throw new AppError("CONFLICT", "A report is required before release");
    if (o.report.by === ctx.userId) throw new AppError("FORBIDDEN", "A second authorised radiologist must review and release the report");
    await orders(ctx.orgId).updateOne({ _id: id, status: "reported" } as never, { $set: { status: "released", verifiedBy: ctx.userId, releasedAt: new Date() } } as never, s);
    if (o.serviceId) await createServiceCharge(ctx, { encounterId: o.encounterId, patientId: o.patientId, doctorId: o.doctorId, serviceId: o.serviceId, qty: 1, autoKey: `rad:${o._id}` }, s);
    await notifyUser(ctx.orgId, o.doctorUserId, { type: "rad.released", title: `Imaging report available: ${o.number} ${o.study}`, refType: "rad_order", refId: o._id }, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "rad.release", resource: "rad_order", resourceId: id });
    return { ...o, status: "released" };
  });
}

export async function getImaging(ctx: Ctx, id: string) {
  assertPermission(ctx, "radiology:view");
  const o = await orders(ctx.orgId).findOne({ _id: id } as never);
  if (!o) throw new AppError("NOT_FOUND", "Imaging order not found");
  if (o.status !== "released" && !ctx.permissions.includes("radiology:update")) return { ...o, report: undefined, reportHidden: true as const };
  return { ...o, reportHidden: false as const };
}
export async function imagingWorklist(ctx: Ctx) {
  assertPermission(ctx, "radiology:update");
  return orders(ctx.orgId).find({ status: { $in: ["ordered", "scheduled", "performed", "reported"] } } as never, { sort: { orderedAt: 1 }, limit: 300 });
}
