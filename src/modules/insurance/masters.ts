import type { Decimal128 } from "mongodb";
import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { money, toDecimal128 } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";

export type Payer = { _id: string; name: string; code: string; kind: "insurer" | "tpa"; active: boolean };
export type Plan = {
  _id: string; payerId: string; name: string; copayPct: number; copayCapPerVisit?: Decimal128; deductible?: Decimal128;
  annualLimit?: Decimal128; preauthServiceCodes: string[]; exclusions: string[]; active: boolean;
};
export type Policy = { _id: string; patientId: string; planId: string; payerId: string; memberNo: string; startDate: Date; endDate: Date; active: boolean };
export type Eligibility = { _id: string; patientId: string; policyId: string; result: "eligible" | "not_eligible" | "unknown"; source: "manual" | "sandbox" | "eclaimlink"; reference?: string; notes?: string; at: Date; by: string };
export type Preauth = {
  _id: string; patientId: string; policyId: string; serviceCodes: string[]; estimatedAmount: Decimal128; status: "requested" | "approved" | "rejected";
  approvedAmount?: Decimal128; reference?: string; requestedAt: Date; requestedBy: string; decidedAt?: Date; decidedBy?: string;
};

const v = <T>(r: { success: true; data: T } | { success: false; error: { message: string } }): T => {
  if (!r.success) throw new AppError("VALIDATION", r.error.message);
  return r.data;
};
const amt = z.string().regex(/^\d+(\.\d{1,2})?$/);

async function insert<T extends { _id: string }>(ctx: Ctx, col: string, doc: T, action: string) {
  await withTransaction(async (s) => {
    await tenantCol<T>(ctx.orgId, col).insertOne(doc as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action, resource: col, resourceId: doc._id, after: doc });
  });
  return doc;
}

export async function createPayer(ctx: Ctx, input: { name: string; code: string; kind: "insurer" | "tpa" }): Promise<Payer> {
  assertPermission(ctx, "insurance:create");
  const d = v(z.object({ name: z.string().min(2), code: z.string().min(2), kind: z.enum(["insurer", "tpa"]) }).safeParse(input));
  return insert<Payer>(ctx, "payers", { _id: newId(), ...d, active: true }, "payer.create");
}

export async function createPlan(ctx: Ctx, input: {
  payerId: string; name: string; copayPct: number; copayCapPerVisit?: string; deductible?: string; annualLimit?: string; preauthServiceCodes?: string[]; exclusions?: string[];
}): Promise<Plan> {
  assertPermission(ctx, "insurance:create");
  const d = v(z.object({
    payerId: z.string(), name: z.string().min(2), copayPct: z.number().min(0).max(100), copayCapPerVisit: amt.optional(), deductible: amt.optional(),
    annualLimit: amt.optional(), preauthServiceCodes: z.array(z.string()).default([]), exclusions: z.array(z.string()).default([]),
  }).safeParse(input));
  if (!(await tenantCol<Payer>(ctx.orgId, "payers").findOne({ _id: d.payerId } as never))) throw new AppError("NOT_FOUND", "Payer not found");
  const D = (x?: string) => (x ? toDecimal128(money(x)) : undefined);
  return insert<Plan>(ctx, "plans", {
    _id: newId(), payerId: d.payerId, name: d.name, copayPct: d.copayPct, copayCapPerVisit: D(d.copayCapPerVisit), deductible: D(d.deductible),
    annualLimit: D(d.annualLimit), preauthServiceCodes: d.preauthServiceCodes, exclusions: d.exclusions, active: true,
  }, "plan.create");
}

export async function createPolicy(ctx: Ctx, input: { patientId: string; planId: string; memberNo: string; startDate: Date; endDate: Date }): Promise<Policy> {
  assertPermission(ctx, "insurance:create");
  const d = v(z.object({ patientId: z.string(), planId: z.string(), memberNo: z.string().min(3), startDate: z.coerce.date(), endDate: z.coerce.date() }).safeParse(input));
  if (d.endDate <= d.startDate) throw new AppError("VALIDATION", "Policy end must be after start");
  const plan = await tenantCol<Plan>(ctx.orgId, "plans").findOne({ _id: d.planId } as never);
  if (!plan) throw new AppError("NOT_FOUND", "Plan not found");
  if (!(await tenantCol(ctx.orgId, "patients").findOne({ _id: d.patientId } as never))) throw new AppError("NOT_FOUND", "Patient not found");
  return insert<Policy>(ctx, "policies", { _id: newId(), ...d, payerId: plan.payerId, active: true }, "policy.create");
}

/** Records the outcome of an eligibility check. Source is "manual" (staff verified with the payer) or "sandbox"; there is no live payer connection. */
export async function recordEligibility(ctx: Ctx, input: { patientId: string; policyId: string; result: Eligibility["result"]; source: Eligibility["source"]; reference?: string; notes?: string }): Promise<Eligibility> {
  assertPermission(ctx, "insurance:create");
  const d = v(z.object({ patientId: z.string(), policyId: z.string(), result: z.enum(["eligible", "not_eligible", "unknown"]), source: z.enum(["manual", "sandbox", "eclaimlink"]), reference: z.string().optional(), notes: z.string().optional() }).safeParse(input));
  const pol = await tenantCol<Policy>(ctx.orgId, "policies").findOne({ _id: d.policyId, patientId: d.patientId } as never);
  if (!pol) throw new AppError("NOT_FOUND", "Policy not found for this patient");
  return insert<Eligibility>(ctx, "eligibility_checks", { _id: newId(), ...d, at: new Date(), by: ctx.userId }, "eligibility.record");
}

export async function requestPreauth(ctx: Ctx, input: { patientId: string; policyId: string; serviceCodes: string[]; estimatedAmount: string }): Promise<Preauth> {
  assertPermission(ctx, "insurance:create");
  const d = v(z.object({ patientId: z.string(), policyId: z.string(), serviceCodes: z.array(z.string()).min(1), estimatedAmount: amt }).safeParse(input));
  if (!(await tenantCol<Policy>(ctx.orgId, "policies").findOne({ _id: d.policyId, patientId: d.patientId } as never))) throw new AppError("NOT_FOUND", "Policy not found for this patient");
  return insert<Preauth>(ctx, "preauths", {
    _id: newId(), patientId: d.patientId, policyId: d.policyId, serviceCodes: d.serviceCodes, estimatedAmount: toDecimal128(money(d.estimatedAmount)),
    status: "requested", requestedAt: new Date(), requestedBy: ctx.userId,
  }, "preauth.request");
}

export async function decidePreauth(ctx: Ctx, id: string, input: { approved: boolean; approvedAmount?: string; reference?: string }): Promise<void> {
  assertPermission(ctx, "insurance:approve");
  if (input.approved && !input.reference?.trim()) throw new AppError("VALIDATION", "Payer approval reference required");
  await withTransaction(async (s) => {
    const res = await tenantCol<Preauth>(ctx.orgId, "preauths").updateOne({ _id: id, status: "requested" } as never, {
      $set: {
        status: input.approved ? "approved" : "rejected", reference: input.reference, decidedAt: new Date(), decidedBy: ctx.userId,
        ...(input.approvedAmount ? { approvedAmount: toDecimal128(money(input.approvedAmount)) } : {}),
      },
    } as never, s);
    if (res.matchedCount === 0) throw new AppError("CONFLICT", "Pre-authorisation not found or already decided");
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: input.approved ? "preauth.approve" : "preauth.reject", resource: "preauths", resourceId: id, after: input });
  });
}

export async function listPayers(ctx: Ctx) { assertPermission(ctx, "insurance:view"); return tenantCol<Payer>(ctx.orgId, "payers").find({} as never, { sort: { name: 1 } }); }
export async function listPlans(ctx: Ctx) { assertPermission(ctx, "insurance:view"); return tenantCol<Plan>(ctx.orgId, "plans").find({} as never, { sort: { name: 1 } }); }
export async function listPolicies(ctx: Ctx, patientId: string) { assertPermission(ctx, "insurance:view"); return tenantCol<Policy>(ctx.orgId, "policies").find({ patientId } as never); }
export async function listPreauths(ctx: Ctx) { assertPermission(ctx, "insurance:view"); return tenantCol<Preauth>(ctx.orgId, "preauths").find({} as never, { sort: { requestedAt: -1 }, limit: 100 }); }
export async function latestEligibility(ctx: Ctx, policyId: string) {
  assertPermission(ctx, "insurance:view");
  const rows = await tenantCol<Eligibility>(ctx.orgId, "eligibility_checks").find({ policyId } as never, { sort: { at: -1 }, limit: 1 });
  return rows[0] ?? null;
}
