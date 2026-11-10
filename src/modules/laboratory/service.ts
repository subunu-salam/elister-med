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
import { getPatient } from "@/modules/patients/service";

export type RefRange = { sex?: "male" | "female"; ageMinYears?: number; ageMaxYears?: number; low: number; high: number; criticalLow?: number; criticalHigh?: number };
export type LabTest = {
  _id: string; code: string; name: string; loinc?: string; specimen: string; unit: string; ranges: RefRange[]; rangesApprovedBy?: string; rangesApprovedAt?: Date;
  serviceId?: string; active: boolean;
};
export type Flag = "normal" | "low" | "high" | "critical_low" | "critical_high" | "range_unreviewed" | "no_range";
export type OrderTest = { testId: string; code: string; name: string; unit: string; value?: number; flag?: Flag; enteredBy?: string; enteredAt?: Date; verifiedBy?: string; verifiedAt?: Date };
export type LabOrder = {
  _id: string; number: string; encounterId: string; patientId: string; doctorId: string; doctorUserId?: string; priority: "routine" | "urgent" | "stat";
  tests: OrderTest[]; status: "ordered" | "collected" | "received" | "processing" | "resulted" | "verified" | "released" | "cancelled";
  barcode?: string; collectedAt?: Date; collectedBy?: string; externalLab?: string; orderedAt: Date; orderedBy: string; releasedAt?: Date; releasedBy?: string;
};
export type CriticalAlert = { _id: string; orderId: string; testName: string; value: number; flag: Flag; status: "open" | "acknowledged"; acknowledgedBy?: string; note?: string; at: Date };

const tests = (o: string) => tenantCol<LabTest>(o, "lab_tests");
const orders = (o: string) => tenantCol<LabOrder>(o, "lab_orders");
const alerts = (o: string) => tenantCol<CriticalAlert>(o, "lab_critical_alerts");
const v = <T>(r: { success: true; data: T } | { success: false; error: { message: string } }): T => { if (!r.success) throw new AppError("VALIDATION", r.error.message); return r.data; };

const RangeIn = z.object({ sex: z.enum(["male", "female"]).optional(), ageMinYears: z.number().min(0).optional(), ageMaxYears: z.number().min(0).optional(), low: z.number(), high: z.number(), criticalLow: z.number().optional(), criticalHigh: z.number().optional() })
  .refine((r) => r.low < r.high, "low must be below high")
  .refine((r) => (r.criticalLow === undefined || r.criticalLow <= r.low) && (r.criticalHigh === undefined || r.criticalHigh >= r.high), "critical limits must lie outside the reference range");

/** Ranges are laboratory configuration. They have NO defaults and are inactive for flagging until a director approves them. */
export async function createLabTest(ctx: Ctx, input: { code: string; name: string; loinc?: string; specimen: string; unit: string; ranges: z.input<typeof RangeIn>[]; serviceId?: string }): Promise<LabTest> {
  assertPermission(ctx, "laboratory:create");
  const d = v(z.object({ code: z.string().min(2), name: z.string().min(2), loinc: z.string().optional(), specimen: z.string().min(2), unit: z.string().min(1), ranges: z.array(RangeIn), serviceId: z.string().optional() }).safeParse(input));
  const t: LabTest = { _id: newId(), ...d, active: true };
  try {
    await withTransaction(async (s) => {
      await tests(ctx.orgId).insertOne(t, s);
      await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "labtest.create", resource: "lab_test", resourceId: t._id, after: { code: t.code } });
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new AppError("CONFLICT", `Test code ${d.code} exists`);
    throw e;
  }
  return t;
}

export async function approveRanges(ctx: Ctx, testId: string): Promise<void> {
  assertPermission(ctx, "laboratory:approve");
  await withTransaction(async (s) => {
    const t = await tests(ctx.orgId).findOne({ _id: testId } as never, s);
    if (!t) throw new AppError("NOT_FOUND", "Test not found");
    if (!t.ranges.length) throw new AppError("VALIDATION", "Configure at least one reference range first");
    await tests(ctx.orgId).updateOne({ _id: testId } as never, { $set: { rangesApprovedBy: ctx.userId, rangesApprovedAt: new Date() } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "labtest.approve_ranges", resource: "lab_test", resourceId: testId, after: { ranges: t.ranges } });
  });
}

const ageYears = (dob: string) => (Date.now() - new Date(dob).getTime()) / (365.25 * 86400000);

function flagFor(t: LabTest, value: number, sex: string, age: number): Flag {
  if (!t.rangesApprovedBy) return "range_unreviewed";
  const r = t.ranges.find((x) => (!x.sex || x.sex === sex) && (x.ageMinYears === undefined || age >= x.ageMinYears) && (x.ageMaxYears === undefined || age <= x.ageMaxYears));
  if (!r) return "no_range";
  if (r.criticalLow !== undefined && value < r.criticalLow) return "critical_low";
  if (r.criticalHigh !== undefined && value > r.criticalHigh) return "critical_high";
  if (value < r.low) return "low";
  if (value > r.high) return "high";
  return "normal";
}

export async function orderLab(ctx: Ctx, input: { encounterId: string; testIds: string[]; priority?: LabOrder["priority"] }): Promise<LabOrder> {
  assertPermission(ctx, "laboratory:create");
  if (!input.testIds.length) throw new AppError("VALIDATION", "Select at least one test");
  const enc = await getEncounterBrief(ctx, input.encounterId);
  const ts = await tests(ctx.orgId).find({ _id: { $in: input.testIds }, active: true } as never);
  if (ts.length !== new Set(input.testIds).size) throw new AppError("NOT_FOUND", "One or more tests not found");
  return withTransaction(async (s) => {
    const year = yearOf();
    const o: LabOrder = {
      _id: newId(), number: docNo("LAB", year, await nextSeq(ctx.orgId, `lab:${year}`, s)), encounterId: enc._id, patientId: enc.patientId, doctorId: enc.doctorId, doctorUserId: enc.doctorUserId,
      priority: input.priority ?? "routine", tests: ts.map((t) => ({ testId: t._id, code: t.code, name: t.name, unit: t.unit })), status: "ordered", orderedAt: new Date(), orderedBy: ctx.userId,
    };
    await orders(ctx.orgId).insertOne(o, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "lab.order", resource: "lab_order", resourceId: o._id, after: { number: o.number, tests: ts.map((t) => t.code) } });
    await emit(s, ctx.orgId, "lab.ordered", { orderId: o._id });
    return o;
  });
}

async function advance(ctx: Ctx, id: string, from: LabOrder["status"][], to: LabOrder["status"], extra: Record<string, unknown>, action: string): Promise<LabOrder> {
  return withTransaction(async (s) => {
    const o = await orders(ctx.orgId).findOne({ _id: id } as never, s);
    if (!o) throw new AppError("NOT_FOUND", "Lab order not found");
    if (!from.includes(o.status)) throw new AppError("CONFLICT", `Order is ${o.status}`);
    await orders(ctx.orgId).updateOne({ _id: id, status: o.status } as never, { $set: { status: to, ...extra } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action, resource: "lab_order", resourceId: id, before: { status: o.status }, after: { status: to } });
    return { ...o, status: to, ...(extra as object) } as LabOrder;
  });
}

export async function collectSample(ctx: Ctx, orderId: string): Promise<LabOrder> {
  assertPermission(ctx, "laboratory:update");
  const n = await nextSeq(ctx.orgId, "labbarcode");
  return advance(ctx, orderId, ["ordered"], "collected", { barcode: `LAB${String(n).padStart(8, "0")}`, collectedAt: new Date(), collectedBy: ctx.userId }, "lab.collect");
}
export async function receiveSample(ctx: Ctx, orderId: string) { assertPermission(ctx, "laboratory:update"); return advance(ctx, orderId, ["collected"], "received", {}, "lab.receive"); }
export async function startProcessing(ctx: Ctx, orderId: string) { assertPermission(ctx, "laboratory:update"); return advance(ctx, orderId, ["received"], "processing", {}, "lab.process"); }
export async function referToExternalLab(ctx: Ctx, orderId: string, labName: string) {
  assertPermission(ctx, "laboratory:update");
  if (!labName.trim()) throw new AppError("VALIDATION", "External laboratory name required");
  return advance(ctx, orderId, ["collected", "received"], "processing", { externalLab: labName }, "lab.refer_external");
}

/** Result entry (manual or imported). Flags use the approved laboratory ranges for the patient's sex and age. Critical values raise an alert. */
export async function enterResult(ctx: Ctx, input: { orderId: string; testId: string; value: number }): Promise<{ flag: Flag }> {
  assertPermission(ctx, "laboratory:update");
  if (!Number.isFinite(input.value)) throw new AppError("VALIDATION", "Result must be a number");
  const o0 = await orders(ctx.orgId).findOne({ _id: input.orderId } as never);
  if (!o0) throw new AppError("NOT_FOUND", "Lab order not found");
  const patient = await getPatient(ctx, o0.patientId);
  return withTransaction(async (s) => {
    const o = (await orders(ctx.orgId).findOne({ _id: input.orderId } as never, s))!;
    if (!["processing", "resulted"].includes(o.status)) throw new AppError("CONFLICT", `Results can only be entered while processing (order is ${o.status})`);
    const ot = o.tests.find((t) => t.testId === input.testId);
    if (!ot) throw new AppError("NOT_FOUND", "Test is not on this order");
    if (ot.verifiedBy) throw new AppError("CONFLICT", "This result is verified and cannot be changed");
    const t = (await tests(ctx.orgId).findOne({ _id: input.testId } as never, s))!;
    const flag = flagFor(t, input.value, patient.sex, ageYears(patient.dob));
    const newTests = o.tests.map((x) => (x.testId === input.testId ? { ...x, value: input.value, flag, enteredBy: ctx.userId, enteredAt: new Date() } : x));
    const all = newTests.every((x) => x.value !== undefined);
    await orders(ctx.orgId).updateOne({ _id: o._id } as never, { $set: { tests: newTests, status: all ? "resulted" : "processing" } } as never, s);
    if (flag === "critical_low" || flag === "critical_high") {
      await alerts(ctx.orgId).insertOne({ _id: newId(), orderId: o._id, testName: t.name, value: input.value, flag, status: "open", at: new Date() }, s);
      await notifyUser(ctx.orgId, o.doctorUserId, { type: "lab.critical", title: `CRITICAL result: ${t.name} ${input.value} ${t.unit} (${o.number})`, refType: "lab_order", refId: o._id, severity: "critical" }, s);
    }
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "lab.result_enter", resource: "lab_order", resourceId: o._id, after: { test: t.code, value: input.value, flag } });
    return { flag };
  });
}

/** Four-eyes: the person who entered a result cannot verify it. */
export async function verifyResults(ctx: Ctx, orderId: string): Promise<LabOrder> {
  assertPermission(ctx, "laboratory:approve");
  return withTransaction(async (s) => {
    const o = await orders(ctx.orgId).findOne({ _id: orderId } as never, s);
    if (!o) throw new AppError("NOT_FOUND", "Lab order not found");
    if (o.status !== "resulted") throw new AppError("CONFLICT", `Order is ${o.status}; all results must be entered first`);
    if (o.tests.some((t) => t.enteredBy === ctx.userId)) throw new AppError("FORBIDDEN", "You entered these results; a second authorised person must verify them");
    const newTests = o.tests.map((t) => ({ ...t, verifiedBy: ctx.userId, verifiedAt: new Date() }));
    await orders(ctx.orgId).updateOne({ _id: o._id, status: "resulted" } as never, { $set: { tests: newTests, status: "verified" } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "lab.verify", resource: "lab_order", resourceId: o._id });
    return { ...o, tests: newTests, status: "verified" };
  });
}

export async function acknowledgeCritical(ctx: Ctx, alertId: string, note: string): Promise<void> {
  assertPermission(ctx, "emr:update");
  if (!note.trim()) throw new AppError("VALIDATION", "Document how the result was acted on");
  await withTransaction(async (s) => {
    const res = await alerts(ctx.orgId).updateOne({ _id: alertId, status: "open" } as never, { $set: { status: "acknowledged", acknowledgedBy: ctx.userId, note } } as never, s);
    if (res.matchedCount === 0) throw new AppError("CONFLICT", "Alert not found or already acknowledged");
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "lab.critical_ack", resource: "lab_critical_alert", resourceId: alertId, after: { note } });
  });
}

/** Release makes results visible to clinicians, notifies the ordering doctor and creates the billable charges. */
export async function releaseOrder(ctx: Ctx, orderId: string): Promise<LabOrder> {
  assertPermission(ctx, "laboratory:approve");
  return withTransaction(async (s) => {
    const o = await orders(ctx.orgId).findOne({ _id: orderId } as never, s);
    if (!o) throw new AppError("NOT_FOUND", "Lab order not found");
    if (o.status !== "verified") throw new AppError("CONFLICT", `Order is ${o.status}; results must be verified before release`);
    const open = await alerts(ctx.orgId).count({ orderId, status: "open" } as never, s);
    if (open > 0) throw new AppError("CONFLICT", "A critical result has not been acknowledged by the clinician");
    await orders(ctx.orgId).updateOne({ _id: o._id, status: "verified" } as never, { $set: { status: "released", releasedAt: new Date(), releasedBy: ctx.userId } } as never, s);
    for (const t of o.tests) {
      const def = await tests(ctx.orgId).findOne({ _id: t.testId } as never, s);
      if (def?.serviceId) await createServiceCharge(ctx, { encounterId: o.encounterId, patientId: o.patientId, doctorId: o.doctorId, serviceId: def.serviceId, qty: 1, autoKey: `lab:${o._id}:${t.testId}` }, s);
    }
    await notifyUser(ctx.orgId, o.doctorUserId, { type: "lab.released", title: `Lab results available: ${o.number}`, refType: "lab_order", refId: o._id, severity: "info" }, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "lab.release", resource: "lab_order", resourceId: o._id });
    await emit(s, ctx.orgId, "lab.released", { orderId: o._id });
    return { ...o, status: "released" };
  });
}

/** Unreleased results are visible to laboratory staff only. */
export async function getOrder(ctx: Ctx, id: string) {
  assertPermission(ctx, "laboratory:view");
  const o = await orders(ctx.orgId).findOne({ _id: id } as never);
  if (!o) throw new AppError("NOT_FOUND", "Lab order not found");
  if (o.status !== "released" && !ctx.permissions.includes("laboratory:update")) {
    return { ...o, tests: o.tests.map((t) => ({ ...t, value: undefined, flag: undefined })), resultsHidden: true as const };
  }
  return { ...o, resultsHidden: false as const };
}

export async function workQueue(ctx: Ctx) {
  assertPermission(ctx, "laboratory:update");
  return orders(ctx.orgId).find({ status: { $in: ["ordered", "collected", "received", "processing", "resulted", "verified"] } } as never, { sort: { orderedAt: 1 }, limit: 300 });
}
export async function listTests(ctx: Ctx) { assertPermission(ctx, "laboratory:view"); return tests(ctx.orgId).find({ active: true } as never, { sort: { name: 1 } }); }
export async function listOpenCritical(ctx: Ctx) { assertPermission(ctx, "laboratory:view"); return alerts(ctx.orgId).find({ status: "open" } as never, { sort: { at: 1 } }); }
export async function listPatientLabOrders(ctx: Ctx, patientId: string) { assertPermission(ctx, "laboratory:view"); return orders(ctx.orgId).find({ patientId } as never, { sort: { orderedAt: -1 }, limit: 100 }); }

export async function labDashboard(ctx: Ctx) {
  assertPermission(ctx, "laboratory:view");
  const all = await orders(ctx.orgId).find({} as never, { limit: 100000 });
  const done = all.filter((o) => o.releasedAt);
  const tat = done.length ? done.reduce((a, o) => a + (o.releasedAt!.getTime() - o.orderedAt.getTime()) / 60000, 0) / done.length : 0;
  const c = (st: string) => all.filter((o) => o.status === st).length;
  return {
    awaitingCollection: c("ordered"), inProcessing: c("collected") + c("received") + c("processing"), awaitingVerification: c("resulted"), verifiedNotReleased: c("verified"), released: c("released"),
    openCriticalAlerts: await alerts(ctx.orgId).count({ status: "open" } as never), avgTurnaroundMinutes: tat,
  };
}
