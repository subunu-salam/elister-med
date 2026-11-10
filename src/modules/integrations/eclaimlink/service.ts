import type { Decimal128 } from "mongodb";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { decryptField, encryptField } from "@/core/crypto";
import { fromDecimal128, money } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import type { Claim } from "@/modules/insurance/claims";
import { postRemittance, recordPayerResponse } from "@/modules/insurance/claims";
import { decidePreauth, recordEligibility, type Payer, type Plan, type Policy, type Preauth } from "@/modules/insurance/masters";
import type { ClaimsAdapter, ClaimPayload, SubmitResult } from "@/modules/insurance/adapters";
import { EClaimLinkClient, EClaimLinkError } from "./client";
import { buildClaimSubmission, buildPriorRequest, kid, kids, parseXml, val, parseDhaDate, type ActivityIn } from "./xml";

/**
 * DHA eClaimLink integration for a facility: configuration, claim and prior-authorisation upload, inbox polling that posts
 * remittances and authorisation decisions into the books, and a full transaction log. Works against the MOCK DHA server today
 * (mode "mock"); "test" and "production" use the same code with DHA's real endpoints once the vendor is onboarded and the SOAP binding
 * in client.ts is completed. Nothing here is certified by DHA.
 */
export type EclMode = "off" | "mock" | "test" | "production";
export type EclConfig = {
  mode: EclMode; baseUrl: string; facilityId: string; login: string; passwordEnc?: string;
  /** our payer code -> the payer/receiver ID DHA uses for it */
  payerMap: Record<string, string>; updatedBy?: string; updatedAt?: Date;
};
export type EclTx = {
  _id: string; direction: "out" | "in"; type: string; fileName: string; xml: string; status: "accepted" | "rejected" | "processed" | "error"; code?: number; message?: string; errors?: string[];
  ref?: string; claimId?: string; preauthId?: string; summary?: string; remoteId?: string; at: Date; by: string;
};

const cfgCol = (o: string) => tenantCol<EclConfig & { key: string }>(o, "eclaimlink_config");
const txCol = (o: string) => tenantCol<EclTx>(o, "eclaimlink_transactions");

export async function getEclConfig(ctx: Ctx): Promise<(Omit<EclConfig, "passwordEnc"> & { hasPassword: boolean }) | null> {
  assertPermission(ctx, "integrations:view");
  const c = await cfgCol(ctx.orgId).findOne({ key: "main" } as never);
  if (!c) return null;
  const { passwordEnc, ...rest } = c as EclConfig & { key: string };
  void (rest as { key?: string }).key;
  return { ...rest, hasPassword: !!passwordEnc };
}

export async function setEclConfig(ctx: Ctx, input: { mode: EclMode; baseUrl: string; facilityId: string; login: string; password?: string; payerMap?: Record<string, string> }): Promise<void> {
  assertPermission(ctx, "integrations:update");
  if (!["off", "mock", "test", "production"].includes(input.mode)) throw new AppError("VALIDATION", "Unknown mode");
  if (input.mode !== "off") {
    if (!/^https?:\/\//.test(input.baseUrl)) throw new AppError("VALIDATION", "Base URL must start with http:// or https://");
    if (!input.facilityId.trim() || !input.login.trim()) throw new AppError("VALIDATION", "Facility ID and login are required");
    if (input.mode === "production" && !input.baseUrl.startsWith("https://")) throw new AppError("VALIDATION", "Production must use https");
  }
  const prior = await cfgCol(ctx.orgId).findOne({ key: "main" } as never);
  const passwordEnc = input.password ? encryptField(input.password) : prior?.passwordEnc;
  if (input.mode !== "off" && !passwordEnc) throw new AppError("VALIDATION", "Enter the eClaimLink password");
  await withTransaction(async (s) => {
    await cfgCol(ctx.orgId).updateOne({ key: "main" } as never, { $set: { key: "main", mode: input.mode, baseUrl: input.baseUrl, facilityId: input.facilityId, login: input.login, passwordEnc, payerMap: input.payerMap ?? prior?.payerMap ?? {}, updatedBy: ctx.userId, updatedAt: new Date() } } as never, s, { upsert: true });
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "eclaimlink.config", resource: "eclaimlink_config", resourceId: "main", after: { mode: input.mode, baseUrl: input.baseUrl, facilityId: input.facilityId, login: input.login } });
  });
}

async function activeConfig(ctx: Ctx): Promise<EclConfig & { key: string }> {
  const c = await cfgCol(ctx.orgId).findOne({ key: "main" } as never);
  if (!c || c.mode === "off") throw new AppError("CONFLICT", "eClaimLink is not enabled for this organisation");
  if (!c.passwordEnc) throw new AppError("CONFLICT", "eClaimLink password is not set");
  return c as EclConfig & { key: string };
}
const clientOf = (c: EclConfig) => new EclaimClient(c);
class EclaimClient extends EClaimLinkClient { constructor(c: EclConfig) { super({ baseUrl: c.baseUrl, login: c.login, password: decryptField(c.passwordEnc!) }); } }
const disposition = (c: EclConfig) => (c.mode === "production" ? "PRODUCTION" : "TEST") as "PRODUCTION" | "TEST";

async function log(ctx: Ctx, t: Omit<EclTx, "_id" | "at" | "by">): Promise<EclTx> {
  const doc: EclTx = { _id: newId(), at: new Date(), by: ctx.userId, ...t };
  await txCol(ctx.orgId).insertOne(doc);
  return doc;
}

// ---------- gathering the data a claim or authorisation needs ----------
type Patient = { _id: string; mrn: string; emiratesIdEnc?: string };
type Staff = { _id: string; userKey?: string; licenceNo?: string };
const ACT_TYPE: Record<string, number> = { consultation: 3, procedure: 3, lab: 3, radiology: 3, pharmacy: 5, dental: 6 };

/** Code mapping hook: local service code -> the CPT/CDT/DHA code the payer expects. Falls back to the local code until a mapping is loaded. */
async function externalCode(ctx: Ctx, local: string): Promise<{ code: string; type: number }> {
  const m = await tenantCol<{ standardCode: string; standardSystem: string }>(ctx.orgId, "code_maps").findOne({ system: "eclaimlink_activity", localCode: local } as never);
  if (m) return { code: m.standardCode, type: m.standardSystem === "CDT" ? 6 : m.standardSystem === "DRUG" ? 5 : m.standardSystem === "HCPCS" ? 4 : 3 };
  return { code: local, type: 3 };
}
async function patientEid(ctx: Ctx, patientId: string): Promise<{ eid: string; mrn: string }> {
  const p = await tenantCol<Patient>(ctx.orgId, "patients").findOne({ _id: patientId } as never);
  if (!p) throw new AppError("NOT_FOUND", "Patient not found");
  if (!p.emiratesIdEnc) throw new AppError("VALIDATION", "Patient has no Emirates ID on file; eClaimLink requires it");
  return { eid: decryptField(p.emiratesIdEnc), mrn: p.mrn };
}
async function payerCode(ctx: Ctx, payerId: string, cfg: EclConfig): Promise<{ code: string; ext: string }> {
  const p = await tenantCol<Payer>(ctx.orgId, "payers").findOne({ _id: payerId } as never);
  if (!p) throw new AppError("NOT_FOUND", "Payer not found");
  return { code: p.code, ext: cfg.payerMap[p.code] ?? p.code };
}

async function buildClaimXml(ctx: Ctx, claim: Claim, cfg: EclConfig): Promise<{ xml: string; payer: string }> {
  const policy = await tenantCol<Policy>(ctx.orgId, "policies").findOne({ _id: claim.policyId } as never);
  if (!policy) throw new AppError("NOT_FOUND", "Policy not found");
  const { eid, mrn } = await patientEid(ctx, claim.patientId);
  const { ext } = await payerCode(ctx, claim.payerId, cfg);
  const inv = await tenantCol<{ lines: { chargeId: string }[]; createdAt: Date }>(ctx.orgId, "invoices").findOne({ _id: claim.invoiceId } as never);
  const charges = await tenantCol<{ _id: string; encounterId: string; doctorId?: string; serviceCode: string; kind: string }>(ctx.orgId, "charges").find({ _id: { $in: (inv?.lines ?? []).map((l) => l.chargeId) } } as never);
  const enc = charges[0] ? await tenantCol<{ openedAt: Date; completedAt?: Date; doctorId: string }>(ctx.orgId, "encounters").findOne({ _id: charges[0].encounterId } as never) : null;
  const start = enc?.openedAt ?? claim.serviceDate, end = enc?.completedAt ?? claim.serviceDate;
  const clinicianOf = async (doctorId?: string) => { const s = doctorId ? await tenantCol<Staff>(ctx.orgId, "staff").findOne({ _id: doctorId } as never) : null; return s?.licenceNo ?? s?.userKey ?? "UNKNOWN"; };
  const approved = await tenantCol<Preauth & { reference?: string }>(ctx.orgId, "preauths").find({ policyId: claim.policyId, status: "approved" } as never);
  const dx = [...new Set(claim.items.flatMap((i) => i.diagnosisCodes))];
  const activities: ActivityIn[] = [];
  for (const [i, it] of claim.items.entries()) {
    const ch = charges[i] ?? charges.find((c) => c.serviceCode === it.serviceCode);
    const ext2 = await externalCode(ctx, it.serviceCode);
    const pa = approved.find((p) => p.serviceCodes.includes(it.serviceCode));
    activities.push({ id: `${claim.number}-${i + 1}`, start, type: ACT_TYPE[ch?.kind ?? ""] === 6 ? 6 : ext2.type, code: ext2.code, quantity: it.qty, net: fromDecimal128(it.payerShare).toFixed(2), clinician: await clinicianOf(ch?.doctorId ?? enc?.doctorId), priorAuth: pa?.reference });
  }
  const gross = claim.items.reduce((a, i) => a.plus(fromDecimal128(i.gross)), money(0));
  const net = fromDecimal128(claim.total);
  const xml = buildClaimSubmission({ sender: cfg.facilityId, receiver: ext, at: new Date(), disposition: disposition(cfg) }, [{
    id: claim.number, memberId: policy.memberNo, payerId: ext, providerId: cfg.facilityId, emiratesId: eid, gross: gross.toFixed(2), patientShare: gross.minus(net).toFixed(2), net: net.toFixed(2),
    encounter: { facilityId: cfg.facilityId, type: 1, patientId: mrn, start, end: end < start ? start : end },
    diagnoses: dx.map((c, i) => ({ type: i === 0 ? "Principal" : "Secondary", code: c })), activities,
    ...(claim.version > 1 ? { resubmission: { type: "correction", comment: `Resubmission v${claim.version} after payer response` } } : {}),
  }]);
  return { xml, payer: ext };
}

/** Sends one claim to eClaimLink. Returns a SubmitResult in the shape the claims workflow expects. */
export async function submitClaimToEcl(ctx: Ctx, claimNumber: string): Promise<SubmitResult> {
  assertPermission(ctx, "insurance:update");
  const cfg = await activeConfig(ctx);
  const claim = await tenantCol<Claim>(ctx.orgId, "claims").findOne({ number: claimNumber } as never);
  if (!claim) throw new AppError("NOT_FOUND", "Claim not found");
  const { xml } = await buildClaimXml(ctx, claim, cfg);
  const fileName = `CLM_${claim.number}_v${claim.version}.xml`;
  let r;
  try { r = await clientOf(cfg).upload(xml, fileName); }
  catch (e) {
    await log(ctx, { direction: "out", type: "Claim.Submission", fileName, xml, status: "error", message: (e as Error).message, claimId: claim._id, ref: claim.number });
    throw new AppError("CONFLICT", `eClaimLink unreachable: ${(e as Error).message}. The claim stays validated; try again.`);
  }
  await log(ctx, { direction: "out", type: "Claim.Submission", fileName, xml, status: r.ok ? "accepted" : "rejected", code: r.code, message: r.message, errors: r.errors, claimId: claim._id, ref: claim.number, remoteId: r.transactionId });
  return { adapter: "eclaimlink", mode: cfg.mode === "production" ? "production" : "sandbox", reference: r.transactionId ?? `REJ-${claim.number}`, status: r.ok ? "received" : "error", errors: r.ok ? [] : r.errors };
}

/** Adapter used by the claims workflow when eClaimLink is enabled. */
export function eclaimlinkAdapter(ctx: Ctx, mode: EclMode): ClaimsAdapter {
  return { name: "eclaimlink", mode: mode === "production" ? "production" : "sandbox", submit: (c: ClaimPayload) => submitClaimToEcl(ctx, c.number) };
}

export async function sendPriorAuth(ctx: Ctx, preauthId: string): Promise<EclTx> {
  assertPermission(ctx, "insurance:create");
  const cfg = await activeConfig(ctx);
  const pa = await tenantCol<Preauth>(ctx.orgId, "preauths").findOne({ _id: preauthId } as never);
  if (!pa) throw new AppError("NOT_FOUND", "Pre-authorisation not found");
  if (pa.status !== "requested") throw new AppError("CONFLICT", `Pre-authorisation is already ${pa.status}`);
  const policy = await tenantCol<Policy>(ctx.orgId, "policies").findOne({ _id: pa.policyId } as never);
  if (!policy) throw new AppError("NOT_FOUND", "Policy not found");
  const { eid } = await patientEid(ctx, pa.patientId);
  const { ext } = await payerCode(ctx, policy.payerId, cfg);
  const latest = (await tenantCol<{ _id: string; doctorId: string; openedAt: Date }>(ctx.orgId, "encounters").find({ patientId: pa.patientId } as never, { sort: { openedAt: -1 }, limit: 1 }))[0];
  const doc = latest ? await tenantCol<Staff>(ctx.orgId, "staff").findOne({ _id: latest.doctorId } as never) : null;
  const dxs = latest ? (await tenantCol<{ diagnoses: { code: string }[] }>(ctx.orgId, "encounters").findOne({ _id: latest._id } as never))?.diagnoses ?? [] : [];
  const each = money(pa.estimatedAmount.toString()).div(pa.serviceCodes.length);
  const activities: ActivityIn[] = [];
  for (const [i, code] of pa.serviceCodes.entries()) { const x = await externalCode(ctx, code); activities.push({ id: `${pa._id}-${i + 1}`, start: new Date(), type: x.type, code: x.code, quantity: 1, net: each.toFixed(2), clinician: doc?.licenceNo ?? doc?.userKey ?? "UNKNOWN" }); }
  const xml = buildPriorRequest({ sender: cfg.facilityId, receiver: ext, at: new Date(), disposition: disposition(cfg) }, {
    id: pa._id, memberId: policy.memberNo, payerId: ext, emiratesId: eid, ordered: pa.requestedAt, facilityId: cfg.facilityId,
    diagnoses: (dxs.length ? dxs.map((d) => d.code) : ["Z00.00"]).map((c, i) => ({ type: i === 0 ? "Principal" : "Secondary", code: c })), activities,
  });
  const fileName = `PRI_${pa._id}.xml`;
  let r;
  try { r = await clientOf(cfg).upload(xml, fileName); } catch (e) { throw new AppError("CONFLICT", `eClaimLink unreachable: ${(e as Error).message}`); }
  const t = await log(ctx, { direction: "out", type: "Prior.Request", fileName, xml, status: r.ok ? "accepted" : "rejected", code: r.code, message: r.message, errors: r.errors, preauthId: pa._id, ref: pa._id, remoteId: r.transactionId });
  if (!r.ok) throw new AppError("VALIDATION", `eClaimLink rejected the request: ${r.errors.join("; ")}`);
  return t;
}

export async function checkEligibilityEcl(ctx: Ctx, policyId: string): Promise<{ eligible: boolean; reference: string; notes: string }> {
  assertPermission(ctx, "insurance:create");
  const cfg = await activeConfig(ctx);
  const policy = await tenantCol<Policy>(ctx.orgId, "policies").findOne({ _id: policyId } as never);
  if (!policy) throw new AppError("NOT_FOUND", "Policy not found");
  const { ext } = await payerCode(ctx, policy.payerId, cfg);
  let eid: string | undefined;
  try { eid = (await patientEid(ctx, policy.patientId)).eid; } catch { /* eligibility can proceed on member number alone */ }
  const r = await clientOf(cfg).eligibility({ memberId: policy.memberNo, payerId: ext, emiratesId: eid });
  await recordEligibility(ctx, { patientId: policy.patientId, policyId, result: r.eligible ? "eligible" : "not_eligible", source: "eclaimlink", reference: r.reference, notes: r.notes });
  return r;
}

export async function testConnection(ctx: Ctx): Promise<{ ok: boolean; message: string }> {
  assertPermission(ctx, "integrations:update");
  const cfg = await activeConfig(ctx);
  try { const n = (await clientOf(cfg).inbox()).length; return { ok: true, message: `Connected as ${cfg.login} (${cfg.facilityId}). ${n} new transaction(s) waiting.` }; }
  catch (e) { return { ok: false, message: (e as Error).message }; }
}

export type PollSummary = { found: number; remittances: number; claimsPaid: number; claimsDenied: number; claimsPartial: number; authApproved: number; authRefused: number; amountPaid: string; problems: string[] };

/**
 * Downloads new inbound transactions and applies them: remittances become insurance receipts in the ledger (via postRemittance),
 * fully denied claims are marked rejected so they can be corrected and resubmitted, and authorisation decisions update the pre-authorisation.
 * Each file is processed once (by DHA file ID) and only marked downloaded after it has been applied. Needs insurance:approve.
 */
export async function pollInbox(ctx: Ctx): Promise<PollSummary> {
  assertPermission(ctx, "insurance:approve");
  const cfg = await activeConfig(ctx);
  const client = clientOf(cfg);
  const sum: PollSummary = { found: 0, remittances: 0, claimsPaid: 0, claimsDenied: 0, claimsPartial: 0, authApproved: 0, authRefused: 0, amountPaid: "0.00", problems: [] };
  let paidTotal = money(0);
  const inbox = await client.inbox();
  sum.found = inbox.length;
  for (const item of inbox) {
    if (await txCol(ctx.orgId).findOne({ remoteId: item.fileId, direction: "in", status: "processed" } as never)) { await client.markDownloaded(item.fileId); continue; }
    const { fileName, xml } = await client.download(item.fileId);
    try {
      const root = parseXml(xml);
      const notes: string[] = [];
      if (root.name === "Claim.Remittance") {
        const payerId = val(kid(root, "Header"), "SenderID");
        const byPayer = new Map<string, { claimId: string; paid: string; denied?: string; reason?: string }[]>();
        let ref = "";
        for (const c of kids(root, "Claim")) {
          const claim = await tenantCol<Claim>(ctx.orgId, "claims").findOne({ number: val(c, "ID") } as never);
          if (!claim) { sum.problems.push(`Remittance for unknown claim ${val(c, "ID")}`); continue; }
          ref = val(c, "PaymentReference") || ref;
          const acts = kids(c, "Activity");
          const paid = acts.reduce((a, x) => a.plus(val(x, "PaymentAmount") || "0"), money(0));
          const net = acts.reduce((a, x) => a.plus(val(x, "Net") || "0"), money(0));
          const denied = net.minus(paid);
          const reasons = [...new Set(acts.map((x) => val(x, "DenialCode")).filter(Boolean))];
          if (paid.lte(0)) {
            await recordPayerResponse(ctx, claim._id, { outcome: "rejected", reason: reasons.join(", ") || "Denied by payer" });
            sum.claimsDenied++; notes.push(`${claim.number}: denied ${reasons.join(",")}`);
          } else {
            const key = claim.payerId; const l = byPayer.get(key) ?? []; l.push({ claimId: claim._id, paid: paid.toFixed(2), ...(denied.gt(0) ? { denied: denied.toFixed(2), reason: reasons.join(", ") } : {}) }); byPayer.set(key, l);
            if (denied.gt(0)) sum.claimsPartial++; else sum.claimsPaid++;
            paidTotal = paidTotal.plus(paid); notes.push(`${claim.number}: paid ${paid.toFixed(2)}${denied.gt(0) ? `, denied ${denied.toFixed(2)} (${reasons.join(",")})` : ""}`);
          }
        }
        for (const [pid, lines] of byPayer) await postRemittance(ctx, { payerId: pid, reference: `${ref || item.fileId}${byPayer.size > 1 ? `-${pid.slice(-4)}` : ""}`, lines });
        sum.remittances++;
        void payerId;
      } else if (root.name === "Prior.Authorization") {
        const a = kid(root, "Authorization")!;
        const id = val(a, "ID");
        const pa = await tenantCol<Preauth>(ctx.orgId, "preauths").findOne({ _id: id } as never);
        if (!pa) sum.problems.push(`Authorisation decision for unknown request ${id}`);
        else if (pa.status !== "requested") notes.push(`${id}: already ${pa.status}`);
        else if (val(a, "Result") === "Yes") { await decidePreauth(ctx, id, { approved: true, approvedAmount: Number(val(a, "Limit") || pa.estimatedAmount.toString()).toFixed(2), reference: val(a, "IDPayer") || item.fileId }); sum.authApproved++; notes.push(`${id}: approved ${val(a, "IDPayer")}`); }
        else { await decidePreauth(ctx, id, { approved: false, reference: val(a, "Comments") }); sum.authRefused++; notes.push(`${id}: refused (${val(a, "Comments")})`); }
      } else { sum.problems.push(`Unsupported inbound transaction ${root.name} (${fileName})`); }
      await log(ctx, { direction: "in", type: root.name, fileName, xml, status: "processed", remoteId: item.fileId, summary: notes.join("; ") || undefined, ref: item.fileId });
      await client.markDownloaded(item.fileId);
    } catch (e) {
      const msg = (e as Error).message;
      sum.problems.push(`${fileName}: ${msg}`);
      await log(ctx, { direction: "in", type: item.transactionType, fileName, xml, status: "error", message: msg, remoteId: item.fileId, ref: item.fileId });
    }
  }
  sum.amountPaid = paidTotal.toFixed(2);
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "eclaimlink.poll", resource: "eclaimlink", resourceId: "main", after: sum as unknown as Record<string, unknown> }));
  return sum;
}

export async function listEclTransactions(ctx: Ctx, limit = 100) {
  assertPermission(ctx, "insurance:view");
  return txCol(ctx.orgId).find({} as never, { sort: { at: -1 }, limit });
}
export { EClaimLinkError, parseDhaDate };
export type { Decimal128, Plan };
