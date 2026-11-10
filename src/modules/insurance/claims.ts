import Decimal from "decimal.js";
import type { ClientSession, Decimal128 } from "mongodb";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { emit } from "@/core/outbox";
import { nextSeq } from "@/core/counters";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { fromDecimal128, money, round2, sum, toDecimal128 } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { accountBySystem } from "@/modules/ledger/accounts";
import { postJournalSystem } from "@/modules/ledger/journal";
import { docNo, finalizeInvoice, yearOf, invoices } from "@/modules/billing/invoice";
import { getChargesByIds } from "@/modules/billing/charges";
import type { Invoice, InvoiceLine } from "@/modules/billing/types";
import { listEncounterDiagnoses } from "@/modules/emr/service";
import { adapterFor } from "./adapters";
import type { Plan, Policy, Preauth, Eligibility } from "./masters";

export type ClaimStatus = "draft" | "validated" | "submitted" | "accepted" | "rejected" | "partially_paid" | "paid" | "written_off";
export type ClaimItem = { serviceCode: string; name: string; qty: number; gross: Decimal128; patientShare: Decimal128; payerShare: Decimal128; diagnosisCodes: string[] };
export type Claim = {
  _id: string; number: string; invoiceId: string; patientId: string; policyId: string; payerId: string; planId: string;
  status: ClaimStatus; version: number; items: ClaimItem[]; total: Decimal128; outstanding: Decimal128; paid: Decimal128; writtenOff: Decimal128;
  validationErrors: string[]; serviceDate: Date;
  submissions: { adapter: string; mode: string; reference: string; status: string; errors: string[]; at: Date; version: number }[];
  denials: { reason: string; at: Date; stage: string }[];
  history: { status: ClaimStatus; at: Date; by: string; note?: string }[];
  createdAt: Date; createdBy: string;
};
export type Remittance = { _id: string; payerId: string; reference: string; lines: { claimId: string; paid: Decimal128; denied: Decimal128; reason?: string }[]; total: Decimal128; journalEntryId: string; at: Date; by: string };

const claims = (orgId: string) => tenantCol<Claim>(orgId, "claims");

/** DHA eClaimLink when the organisation has enabled it (mock, test or production), otherwise the sandbox adapter. */
async function pickAdapter(ctx: Ctx, payerId: string) {
  const cfg = await tenantCol<{ mode: "off" | "mock" | "test" | "production" }>(ctx.orgId, "eclaimlink_config").findOne({ key: "main" } as never);
  if (cfg && cfg.mode !== "off") return (await import("@/modules/integrations/eclaimlink/service")).eclaimlinkAdapter(ctx, cfg.mode);
  return adapterFor(payerId);
}
const v2 = (d: Decimal128 | undefined) => fromDecimal128(d).toFixed(2);

async function loadClaim(ctx: Ctx, id: string, s?: ClientSession): Promise<Claim> {
  const c = await claims(ctx.orgId).findOne({ _id: id } as never, s);
  if (!c) throw new AppError("NOT_FOUND", "Claim not found");
  return c;
}

/** Payer portion: covered lines pay (100 - copay)%, capped so the patient's covered copay never exceeds the per-visit cap. Excluded services are patient-pay. */
function payerPortion(plan: Plan) {
  return (lines: InvoiceLine[], total: Decimal): Decimal => {
    let coveredGross = money(0);
    for (const l of lines) if (!plan.exclusions.includes(l.serviceCode)) coveredGross = coveredGross.plus(fromDecimal128(l.gross));
    let copay = coveredGross.times(plan.copayPct).div(100);
    if (plan.copayCapPerVisit) copay = Decimal.min(copay, fromDecimal128(plan.copayCapPerVisit));
    return Decimal.min(coveredGross.minus(copay), total);
  };
}

export async function finalizeInsuredInvoice(ctx: Ctx, input: { patientId: string; chargeIds: string[]; policyId: string }): Promise<{ invoice: Invoice; claim: Claim }> {
  assertPermission(ctx, "insurance:create");
  const policy = await tenantCol<Policy>(ctx.orgId, "policies").findOne({ _id: input.policyId, patientId: input.patientId } as never);
  if (!policy) throw new AppError("NOT_FOUND", "Policy not found for this patient");
  const now = new Date();
  if (!policy.active || policy.startDate > now || policy.endDate < now) throw new AppError("VALIDATION", "Policy is not active on today's date");
  const elig = (await tenantCol<Eligibility>(ctx.orgId, "eligibility_checks").find({ policyId: policy._id } as never, { sort: { at: -1 }, limit: 1 }))[0];
  if (!elig || elig.result !== "eligible") throw new AppError("VALIDATION", "Eligibility not verified: record an eligible check before invoicing the payer");
  const plan = (await tenantCol<Plan>(ctx.orgId, "plans").findOne({ _id: policy.planId } as never))!;

  const invoice = await finalizeInvoice(ctx, {
    patientId: input.patientId, chargeIds: input.chargeIds,
    insurance: { policyId: policy._id, payerId: policy.payerId, compute: payerPortion(plan) },
  });
  const claim = await createClaim(ctx, invoice);
  return { invoice, claim };
}

/** One claim per invoice (unique index). Idempotent. */
async function createClaim(ctx: Ctx, inv: Invoice): Promise<Claim> {
  const existing = await claims(ctx.orgId).findOne({ invoiceId: inv._id } as never);
  if (existing) return existing;
  const total = fromDecimal128(inv.total), payer = fromDecimal128(inv.payerShare);
  const charges = await getChargesByIds(ctx, inv.lines.map((l) => l.chargeId));
  const dx = await listEncounterDiagnoses(ctx, [...new Set(charges.map((c) => c.encounterId))]);
  const encOf = new Map(charges.map((c) => [c._id, c.encounterId]));

  let allocated = money(0);
  const items: ClaimItem[] = inv.lines.map((l, i) => {
    const gross = fromDecimal128(l.gross);
    const last = i === inv.lines.length - 1;
    const payerLine = last ? payer.minus(allocated) : round2(gross.times(payer).div(total));
    allocated = allocated.plus(payerLine);
    return {
      serviceCode: l.serviceCode, name: l.name, qty: l.qty, gross: l.gross, payerShare: toDecimal128(payerLine), patientShare: toDecimal128(gross.minus(payerLine)),
      diagnosisCodes: dx.get(encOf.get(l.chargeId) ?? "") ?? [],
    };
  });
  const policy = (await tenantCol<Policy>(ctx.orgId, "policies").findOne({ _id: inv.policyId } as never))!;
  try {
    return await withTransaction(async (s) => {
      const year = yearOf();
      const c: Claim = {
        _id: newId(), number: docNo("CLM", year, await nextSeq(ctx.orgId, `claim:${year}`, s)), invoiceId: inv._id, patientId: inv.patientId,
        policyId: policy._id, payerId: policy.payerId, planId: policy.planId, status: "draft", version: 1, items, total: toDecimal128(payer),
        outstanding: toDecimal128(payer), paid: toDecimal128(money(0)), writtenOff: toDecimal128(money(0)), validationErrors: [], serviceDate: inv.createdAt,
        submissions: [], denials: [], history: [{ status: "draft", at: new Date(), by: ctx.userId }], createdAt: new Date(), createdBy: ctx.userId,
      };
      await claims(ctx.orgId).insertOne(c, s);
      await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "claim.create", resource: "claim", resourceId: c._id, after: { number: c.number, total: v2(c.total) } });
      await emit(s, ctx.orgId, "claim.created", { claimId: c._id });
      return c;
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) return (await claims(ctx.orgId).findOne({ invoiceId: inv._id } as never))!;
    throw e;
  }
}

export async function validateClaim(ctx: Ctx, claimId: string): Promise<{ claim: Claim; errors: string[] }> {
  assertPermission(ctx, "insurance:update");
  return withTransaction(async (s) => {
    const c = await loadClaim(ctx, claimId, s);
    if (!["draft", "validated"].includes(c.status)) throw new AppError("CONFLICT", `Claim is ${c.status}; only draft claims can be validated`);
    const errors: string[] = [];
    if (!c.items.length) errors.push("Claim has no items");
    for (const i of c.items) {
      if (!i.diagnosisCodes.length) errors.push(`Missing diagnosis code for service ${i.serviceCode}`);
      if (fromDecimal128(i.gross).lte(0)) errors.push(`Non-positive amount for ${i.serviceCode}`);
    }
    if (!fromDecimal128(c.total).equals(sum(c.items.map((i) => fromDecimal128(i.payerShare))))) errors.push("Item payer shares do not add up to the claim total");
    const policy = await tenantCol<Policy>(ctx.orgId, "policies").findOne({ _id: c.policyId } as never);
    if (!policy || c.serviceDate < policy.startDate || c.serviceDate > policy.endDate) errors.push("Service date is outside the policy period");
    const plan = await tenantCol<Plan>(ctx.orgId, "plans").findOne({ _id: c.planId } as never);
    const need = c.items.map((i) => i.serviceCode).filter((code) => plan?.preauthServiceCodes.includes(code));
    if (need.length) {
      const approved = await tenantCol<Preauth>(ctx.orgId, "preauths").find({ policyId: c.policyId, status: "approved" } as never, { session: s });
      const covered = new Set(approved.flatMap((p) => p.serviceCodes));
      for (const code of new Set(need)) if (!covered.has(code)) errors.push(`Pre-authorisation required and not approved for service ${code}`);
    }
    const status: ClaimStatus = errors.length ? "draft" : "validated";
    await claims(ctx.orgId).updateOne({ _id: c._id } as never, { $set: { validationErrors: errors, status }, ...(status !== c.status ? { $push: { history: { status, at: new Date(), by: ctx.userId } } } : {}) } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "claim.validate", resource: "claim", resourceId: c._id, after: { errors } });
    return { claim: { ...c, status, validationErrors: errors }, errors };
  });
}

export async function submitClaim(ctx: Ctx, claimId: string): Promise<Claim> {
  assertPermission(ctx, "insurance:update");
  const c = await loadClaim(ctx, claimId);
  if (c.status !== "validated") throw new AppError("CONFLICT", "Only validated claims can be submitted");
  const adapter = await pickAdapter(ctx, c.payerId);
  const res = await adapter.submit({
    number: c.number, version: c.version, payerId: c.payerId, total: v2(c.total),
    items: c.items.map((i) => ({ serviceCode: i.serviceCode, diagnosisCodes: i.diagnosisCodes, payerShare: v2(i.payerShare) })),
  });
  if (res.status === "error") throw new AppError("CONFLICT", `Submission rejected by ${res.adapter}: ${res.errors.join("; ")}`);
  return withTransaction(async (s) => {
    const up = await claims(ctx.orgId).updateOne({ _id: c._id, status: "validated" } as never, {
      $set: { status: "submitted" },
      $push: { submissions: { adapter: res.adapter, mode: res.mode, reference: res.reference, status: res.status, errors: res.errors, at: new Date(), version: c.version }, history: { status: "submitted", at: new Date(), by: ctx.userId } },
    } as never, s);
    if (up.matchedCount === 0) throw new AppError("CONFLICT", "Claim changed concurrently");
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "claim.submit", resource: "claim", resourceId: c._id, after: { adapter: res.adapter, mode: res.mode, reference: res.reference } });
    await emit(s, ctx.orgId, "claim.submitted", { claimId: c._id });
    return { ...c, status: "submitted", submissions: [...c.submissions, { adapter: res.adapter, mode: res.mode, reference: res.reference, status: res.status, errors: res.errors, at: new Date(), version: c.version }] };
  });
}

export async function recordPayerResponse(ctx: Ctx, claimId: string, r: { outcome: "accepted" | "rejected"; reason?: string }): Promise<Claim> {
  assertPermission(ctx, "insurance:update");
  if (r.outcome === "rejected" && !r.reason?.trim()) throw new AppError("VALIDATION", "A denial reason is required");
  return withTransaction(async (s) => {
    const c = await loadClaim(ctx, claimId, s);
    if (c.status !== "submitted") throw new AppError("CONFLICT", "Only submitted claims can receive a payer response");
    const status: ClaimStatus = r.outcome === "accepted" ? "accepted" : "rejected";
    await claims(ctx.orgId).updateOne({ _id: c._id } as never, {
      $set: { status },
      $push: { history: { status, at: new Date(), by: ctx.userId, note: r.reason }, ...(r.outcome === "rejected" ? { denials: { reason: r.reason!, at: new Date(), stage: "response" } } : {}) },
    } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: `claim.${status}`, resource: "claim", resourceId: c._id, after: r });
    return { ...c, status };
  });
}

export async function resubmitClaim(ctx: Ctx, claimId: string): Promise<Claim> {
  assertPermission(ctx, "insurance:update");
  return withTransaction(async (s) => {
    const c = await loadClaim(ctx, claimId, s);
    if (c.status !== "rejected") throw new AppError("CONFLICT", "Only rejected claims can be resubmitted");
    await claims(ctx.orgId).updateOne({ _id: c._id } as never, { $set: { status: "draft", version: c.version + 1, validationErrors: [] }, $push: { history: { status: "draft", at: new Date(), by: ctx.userId, note: "resubmission" } } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "claim.resubmit", resource: "claim", resourceId: c._id, after: { version: c.version + 1 } });
    return { ...c, status: "draft", version: c.version + 1 };
  });
}

/** Payer remittance: Dr Bank / Cr AR-Insurance for paid amounts. Denied amounts stay on the claim until resubmitted or written off. Idempotent per (payer, reference). */
export async function postRemittance(
  ctx: Ctx, input: { payerId: string; reference: string; lines: { claimId: string; paid: string; denied?: string; reason?: string }[] },
): Promise<Remittance> {
  assertPermission(ctx, "insurance:approve");
  if (!input.reference.trim() || !input.lines.length) throw new AppError("VALIDATION", "Reference and at least one line are required");
  const col = tenantCol<Remittance>(ctx.orgId, "remittances");
  const prior = await col.findOne({ payerId: input.payerId, reference: input.reference } as never);
  if (prior) return prior;
  const run = () => withTransaction(async (s) => {
    const again = await col.findOne({ payerId: input.payerId, reference: input.reference } as never, s);
    if (again) return again;
    const lines: Remittance["lines"] = [];
    let totalPaid = money(0);
    for (const l of input.lines) {
      const paid = money(l.paid), denied = money(l.denied ?? "0");
      if (paid.isNegative() || denied.isNegative() || paid.decimalPlaces() > 2 || denied.decimalPlaces() > 2) throw new AppError("VALIDATION", "Invalid remittance amount");
      const c = await loadClaim(ctx, l.claimId, s);
      if (c.payerId !== input.payerId) throw new AppError("VALIDATION", "Claim belongs to a different payer");
      if (!["submitted", "accepted", "partially_paid"].includes(c.status)) throw new AppError("CONFLICT", `Claim ${c.number} is ${c.status} and cannot be paid`);
      const outstanding = fromDecimal128(c.outstanding);
      if (paid.gt(outstanding)) throw new AppError("VALIDATION", `Payment exceeds outstanding balance on ${c.number}`);
      const newOut = outstanding.minus(paid);
      const status: ClaimStatus = newOut.isZero() ? "paid" : "partially_paid";
      await claims(ctx.orgId).updateOne({ _id: c._id, outstanding: c.outstanding } as never, {
        $set: { outstanding: toDecimal128(newOut), paid: toDecimal128(fromDecimal128(c.paid).plus(paid)), status },
        $push: { history: { status, at: new Date(), by: ctx.userId, note: `remittance ${input.reference}` }, ...(denied.gt(0) ? { denials: { reason: l.reason ?? "Denied (no reason given)", at: new Date(), stage: "remittance" } } : {}) },
      } as never, s);
      totalPaid = totalPaid.plus(paid);
      lines.push({ claimId: c._id, paid: toDecimal128(paid), denied: toDecimal128(denied), reason: l.reason });
    }
    const remId = newId();
    let jeId = "";
    if (totalPaid.gt(0)) {
      const je = await postJournalSystem(ctx, {
        date: new Date(), memo: `Insurance remittance ${input.reference}`, sourceRef: { type: "remittance", id: remId }, idempotencyKey: `remit:${input.payerId}:${input.reference}`,
        lines: [
          { accountId: (await accountBySystem(ctx.orgId, "bank"))._id, debit: totalPaid.toFixed(2), dims: { branchId: ctx.branchId } },
          { accountId: (await accountBySystem(ctx.orgId, "ar_insurance"))._id, credit: totalPaid.toFixed(2), dims: { branchId: ctx.branchId } },
        ],
      }, s);
      jeId = je._id;
    }
    const rem: Remittance = { _id: remId, payerId: input.payerId, reference: input.reference, lines, total: toDecimal128(totalPaid), journalEntryId: jeId, at: new Date(), by: ctx.userId };
    await col.insertOne(rem, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "remittance.post", resource: "remittance", resourceId: remId, after: { reference: input.reference, total: totalPaid.toFixed(2) } });
    await emit(s, ctx.orgId, "remittance.posted", { remittanceId: remId });
    return rem;
  });
  try { return await run(); } catch (e) {
    if ((e as { code?: number }).code === 11000) { const won = await col.findOne({ payerId: input.payerId, reference: input.reference } as never); if (won) return won; }
    throw e;
  }
}

/** Approved write-off of the unpaid remainder: Dr Write-offs / Cr AR-Insurance. */
export async function writeOffClaim(ctx: Ctx, claimId: string, reason: string): Promise<Claim> {
  assertPermission(ctx, "insurance:approve");
  if (!reason.trim()) throw new AppError("VALIDATION", "Reason required");
  return withTransaction(async (s) => {
    const c = await loadClaim(ctx, claimId, s);
    const out = fromDecimal128(c.outstanding);
    if (out.lte(0) || ["draft", "validated"].includes(c.status)) throw new AppError("CONFLICT", "Nothing to write off on this claim in its current state");
    await postJournalSystem(ctx, {
      date: new Date(), memo: `Write-off ${c.number}: ${reason}`, sourceRef: { type: "claim_writeoff", id: c._id }, idempotencyKey: `claim-writeoff:${c._id}`,
      lines: [
        { accountId: (await accountBySystem(ctx.orgId, "writeoff"))._id, debit: out.toFixed(2), dims: { branchId: ctx.branchId } },
        { accountId: (await accountBySystem(ctx.orgId, "ar_insurance"))._id, credit: out.toFixed(2), dims: { branchId: ctx.branchId } },
      ],
    }, s);
    await claims(ctx.orgId).updateOne({ _id: c._id } as never, {
      $set: { outstanding: toDecimal128(money(0)), writtenOff: toDecimal128(fromDecimal128(c.writtenOff).plus(out)), status: "written_off" },
      $push: { history: { status: "written_off", at: new Date(), by: ctx.userId, note: reason } },
    } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "claim.writeoff", resource: "claim", resourceId: c._id, after: { amount: out.toFixed(2), reason } });
    return { ...c, status: "written_off" };
  });
}

export async function listClaims(ctx: Ctx, f: { status?: ClaimStatus } = {}) {
  assertPermission(ctx, "insurance:view");
  return claims(ctx.orgId).find((f.status ? { status: f.status } : {}) as never, { sort: { createdAt: -1 }, limit: 200 });
}
export async function getClaim(ctx: Ctx, id: string) { assertPermission(ctx, "insurance:view"); return loadClaim(ctx, id); }

/** Sub-ledger view for the reconciliation workbench: outstanding per payer and by age. Must equal GL AR-Insurance. */
export async function insuranceReceivables(ctx: Ctx) {
  assertPermission(ctx, "insurance:view");
  const all = await claims(ctx.orgId).find({} as never, { limit: 100000 });
  const byPayer = new Map<string, Decimal>();
  const aging = { "0-30": money(0), "31-60": money(0), "61-90": money(0), "90+": money(0) };
  for (const c of all) {
    const out = fromDecimal128(c.outstanding);
    if (out.isZero()) continue;
    byPayer.set(c.payerId, (byPayer.get(c.payerId) ?? money(0)).plus(out));
    const days = Math.floor((Date.now() - c.createdAt.getTime()) / 86400000);
    aging[days <= 30 ? "0-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+"] = aging[days <= 30 ? "0-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+"].plus(out);
  }
  return { total: sum([...byPayer.values()]), byPayer: [...byPayer].map(([payerId, amount]) => ({ payerId, amount })), aging };
}

export async function denialAnalysis(ctx: Ctx) {
  assertPermission(ctx, "insurance:view");
  const all = await claims(ctx.orgId).find({ "denials.0": { $exists: true } } as never, { limit: 5000 });
  const counts = new Map<string, number>();
  for (const c of all) for (const d of c.denials) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

void invoices;
