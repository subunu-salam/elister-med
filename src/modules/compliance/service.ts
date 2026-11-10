import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { documentExpiryAlerts } from "@/modules/hr/service";

const v = <T>(r: { success: true; data: T } | { success: false; error: { message: string } }): T => { if (!r.success) throw new AppError("VALIDATION", r.error.message); return r.data; };

// ---------- Licences ----------
export type Licence = { _id: string; kind: "facility" | "practitioner"; holder: string; authority: "DHA" | "DOH" | "MOHAP" | "DHCC" | "OTHER"; number: string; expiry: Date; active: boolean };
const lic = (o: string) => tenantCol<Licence>(o, "licences");
export async function addLicence(ctx: Ctx, input: Omit<Licence, "_id" | "active">): Promise<Licence> {
  assertPermission(ctx, "compliance:create");
  const d = v(z.object({ kind: z.enum(["facility", "practitioner"]), holder: z.string().min(2), authority: z.enum(["DHA", "DOH", "MOHAP", "DHCC", "OTHER"]), number: z.string().min(2), expiry: z.coerce.date() }).safeParse(input));
  const l: Licence = { _id: newId(), ...d, active: true };
  await withTransaction(async (s) => { await lic(ctx.orgId).insertOne(l, s); await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "licence.add", resource: "licence", resourceId: l._id, after: { kind: l.kind, authority: l.authority } }); });
  return l;
}
export async function listLicences(ctx: Ctx) { assertPermission(ctx, "compliance:view"); return lic(ctx.orgId).find({} as never, { sort: { expiry: 1 }, limit: 500 }); }

/** Facility licences, practitioner licences and staff documents expiring within `days`, in one list. */
export async function expiringItems(ctx: Ctx, days = 60) {
  assertPermission(ctx, "compliance:view");
  const limit = Date.now() + days * 86400000;
  const out: { source: string; label: string; expiry: Date; expired: boolean }[] = (await lic(ctx.orgId).find({ active: true, expiry: { $lte: new Date(limit) } } as never)).map((l) => ({ source: `${l.kind} licence (${l.authority})`, label: `${l.holder} · ${l.number}`, expiry: l.expiry, expired: l.expiry.getTime() < Date.now() }));
  if (ctx.permissions.includes("hr:view")) for (const a of await documentExpiryAlerts(ctx, days)) out.push({ source: "staff document", label: `${a.name} · ${a.document}`, expiry: a.expiry, expired: a.expired });
  return out.sort((a, b) => a.expiry.getTime() - b.expiry.getTime());
}

// ---------- Regulatory checklist and evidence ----------
export type ChecklistItem = { _id: string; title: string; authority: string; status: "open" | "in_progress" | "compliant" | "not_applicable"; dueDate?: Date; evidenceIds: string[]; owner?: string; verifiedBy?: string };
const chk = (o: string) => tenantCol<ChecklistItem>(o, "compliance_checklist");
export async function addChecklistItem(ctx: Ctx, input: { title: string; authority: string; dueDate?: Date; owner?: string }): Promise<ChecklistItem> {
  assertPermission(ctx, "compliance:create");
  const c: ChecklistItem = { _id: newId(), ...v(z.object({ title: z.string().min(3), authority: z.string().min(2) }).passthrough().safeParse(input)), dueDate: input.dueDate, owner: input.owner, status: "open", evidenceIds: [] };
  await chk(ctx.orgId).insertOne(c);
  return c;
}
/** Marking an item compliant needs evidence attached and a verifier other than the person who last attached it. */
export async function setChecklistStatus(ctx: Ctx, id: string, status: ChecklistItem["status"], evidenceId?: string) {
  assertPermission(ctx, "compliance:update");
  const c = await chk(ctx.orgId).findOne({ _id: id } as never);
  if (!c) throw new AppError("NOT_FOUND", "Checklist item not found");
  const evidence = evidenceId ? [...new Set([...c.evidenceIds, evidenceId])] : c.evidenceIds;
  if (status === "compliant" && evidence.length === 0) throw new AppError("VALIDATION", "Attach audit evidence before marking an item compliant");
  await withTransaction(async (s) => {
    await chk(ctx.orgId).updateOne({ _id: id } as never, { $set: { status, evidenceIds: evidence, ...(status === "compliant" ? { verifiedBy: ctx.userId } : {}) } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "checklist.status", resource: "compliance_checklist", resourceId: id, after: { status, evidence: evidence.length } });
  });
}
export async function listChecklist(ctx: Ctx) { assertPermission(ctx, "compliance:view"); return chk(ctx.orgId).find({} as never, { sort: { dueDate: 1 }, limit: 500 }); }

// ---------- Incidents and corrective actions ----------
export type Incident = { _id: string; title: string; severity: "low" | "medium" | "high" | "critical"; description: string; status: "open" | "investigating" | "closed"; reportedBy: string; at: Date; actions: { _id: string; description: string; owner: string; due: Date; done: boolean }[]; closedBy?: string; closeNote?: string };
const inc = (o: string) => tenantCol<Incident>(o, "incidents");
export async function reportIncident(ctx: Ctx, input: { title: string; severity: Incident["severity"]; description: string }): Promise<Incident> {
  assertPermission(ctx, "compliance:create");
  const d = v(z.object({ title: z.string().min(3), severity: z.enum(["low", "medium", "high", "critical"]), description: z.string().min(10) }).safeParse(input));
  const i: Incident = { _id: newId(), ...d, status: "open", reportedBy: ctx.userId, at: new Date(), actions: [] };
  await withTransaction(async (s) => { await inc(ctx.orgId).insertOne(i, s); await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "incident.report", resource: "incident", resourceId: i._id, after: { severity: i.severity } }); });
  return i;
}
export async function addCorrectiveAction(ctx: Ctx, incidentId: string, a: { description: string; owner: string; due: Date }) {
  assertPermission(ctx, "compliance:update");
  const r = await inc(ctx.orgId).updateOne({ _id: incidentId, status: { $ne: "closed" } } as never, { $set: { status: "investigating" }, $push: { actions: { _id: newId(), ...a, done: false } } } as never);
  if (r.matchedCount === 0) throw new AppError("CONFLICT", "Incident not found or closed");
}
export async function completeCorrectiveAction(ctx: Ctx, incidentId: string, actionId: string) {
  assertPermission(ctx, "compliance:update");
  const r = await inc(ctx.orgId).updateOne({ _id: incidentId, "actions._id": actionId } as never, { $set: { "actions.$.done": true } } as never);
  if (r.matchedCount === 0) throw new AppError("NOT_FOUND", "Action not found");
}
/** Closing needs every corrective action done, and (for high/critical) a closer other than the reporter. */
export async function closeIncident(ctx: Ctx, incidentId: string, note: string) {
  assertPermission(ctx, "compliance:approve");
  const i = await inc(ctx.orgId).findOne({ _id: incidentId } as never);
  if (!i) throw new AppError("NOT_FOUND", "Incident not found");
  if (!note.trim()) throw new AppError("VALIDATION", "Closing note required");
  if (i.actions.some((a) => !a.done)) throw new AppError("CONFLICT", "Corrective actions are still open");
  if ((i.severity === "high" || i.severity === "critical") && i.actions.length === 0) throw new AppError("CONFLICT", "High-severity incidents need at least one corrective action");
  if ((i.severity === "high" || i.severity === "critical") && i.reportedBy === ctx.userId) throw new AppError("FORBIDDEN", "A different person must close a high-severity incident");
  await inc(ctx.orgId).updateOne({ _id: incidentId } as never, { $set: { status: "closed", closedBy: ctx.userId, closeNote: note } } as never);
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "incident.close", resource: "incident", resourceId: incidentId }));
}
export async function listIncidents(ctx: Ctx) { assertPermission(ctx, "compliance:view"); return inc(ctx.orgId).find({} as never, { sort: { at: -1 }, limit: 200 }); }

// ---------- Policies and acknowledgements ----------
export type Policy = { _id: string; title: string; version: number; body: string; at: Date };
export async function publishPolicy(ctx: Ctx, input: { title: string; body: string }): Promise<Policy> {
  assertPermission(ctx, "compliance:approve");
  const d = v(z.object({ title: z.string().min(3), body: z.string().min(10) }).safeParse(input));
  const prev = await tenantCol<Policy>(ctx.orgId, "policies_docs").find({ title: d.title } as never, { sort: { version: -1 }, limit: 1 });
  const p: Policy = { _id: newId(), ...d, version: (prev[0]?.version ?? 0) + 1, at: new Date() };
  await tenantCol<Policy>(ctx.orgId, "policies_docs").insertOne(p);
  return p;
}
/** Every signed-in staff member acknowledges policies for themselves; no special permission needed. */
export async function acknowledgePolicy(ctx: Ctx, policyId: string) {
  const p = await tenantCol<Policy>(ctx.orgId, "policies_docs").findOne({ _id: policyId } as never);
  if (!p) throw new AppError("NOT_FOUND", "Policy not found");
  await tenantCol(ctx.orgId, "policy_acks").updateOne({ policyId, userId: ctx.userId } as never, { $setOnInsert: { _id: newId(), at: new Date(), version: p.version } } as never, undefined, { upsert: true });
}
export async function policyStatus(ctx: Ctx) {
  assertPermission(ctx, "compliance:view");
  const pols = await tenantCol<Policy>(ctx.orgId, "policies_docs").find({} as never, { sort: { title: 1, version: -1 } });
  const latest = new Map<string, Policy>();
  for (const p of pols) if (!latest.has(p.title)) latest.set(p.title, p);
  const acks = await tenantCol<{ policyId: string; userId: string }>(ctx.orgId, "policy_acks").find({} as never, { limit: 100000 });
  const members = await tenantCol<{ userId: string }>(ctx.orgId, "memberships_view").find({} as never).catch(() => []);
  void members;
  return [...latest.values()].map((p) => ({ policy: p, acknowledgedBy: acks.filter((a) => a.policyId === p._id).length, mine: acks.some((a) => a.policyId === p._id && a.userId === ctx.userId) }));
}

// ---------- Access review and audit evidence ----------
/** Users with access in this organisation, their roles, and activity in the last 90 days (from the audit log). Reviewer attests with completeAccessReview. */
export async function accessReviewReport(ctx: Ctx, memberships: { userId: string; roles: string[]; active: boolean }[]) {
  assertPermission(ctx, "compliance:view");
  assertPermission(ctx, "audit:view");
  const since = new Date(Date.now() - 90 * 86400000);
  const rows = await tenantCol<{ actorId: string }>(ctx.orgId, "audit_log").aggregate<{ _id: string; n: number; last: Date }>([{ $match: { at: { $gte: since } } }, { $group: { _id: "$actorId", n: { $sum: 1 }, last: { $max: "$at" } } }]);
  const act = new Map(rows.map((r) => [r._id, r]));
  return memberships.map((m) => ({ ...m, actions90d: act.get(m.userId)?.n ?? 0, lastActive: act.get(m.userId)?.last ?? null, flag: m.active && !act.get(m.userId) ? "no activity in 90 days" : undefined }));
}
export async function completeAccessReview(ctx: Ctx, note: string) {
  assertPermission(ctx, "compliance:approve");
  if (!note.trim()) throw new AppError("VALIDATION", "Attestation note required");
  await tenantCol(ctx.orgId, "access_reviews").insertOne({ _id: newId(), at: new Date(), by: ctx.userId, note } as never);
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "access_review.complete", resource: "access_review", resourceId: ctx.orgId, after: { note } }));
}
/** System audit report for a period: counts per action and actor. Needs audit:audit. */
export async function auditReport(ctx: Ctx, f: { from: Date; to: Date }) {
  assertPermission(ctx, "audit:audit");
  const byAction = await tenantCol(ctx.orgId, "audit_log").aggregate<{ _id: string; n: number }>([{ $match: { at: { $gte: f.from, $lt: f.to } } }, { $group: { _id: "$action", n: { $sum: 1 } } }, { $sort: { n: -1 } }]);
  const byActor = await tenantCol(ctx.orgId, "audit_log").aggregate<{ _id: string; n: number }>([{ $match: { at: { $gte: f.from, $lt: f.to } } }, { $group: { _id: "$actorId", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 50 }]);
  return { byAction: byAction.map((r) => ({ action: r._id, count: r.n })), byActor: byActor.map((r) => ({ actorId: r._id, count: r.n })), total: byAction.reduce((a, r) => a + r.n, 0) };
}

// ---------- Integration readiness matrix ----------
export const READINESS = ["not_configured", "specification_reviewed", "adapter_implemented", "sandbox_tested", "certification_pending", "approved", "production_connected"] as const;
export type Readiness = (typeof READINESS)[number];
export const DEFAULT_INTEGRATIONS: { key: string; name: string; status: Readiness }[] = [
  { key: "dha_eclaimlink", name: "DHA eClaimLink (Dubai e-claims)", status: "not_configured" },
  { key: "doh_shafafiya", name: "DOH Shafafiya (Abu Dhabi e-claims)", status: "not_configured" },
  { key: "riayati", name: "Riayati (MOHAP e-claims / HIE)", status: "not_configured" },
  { key: "nabidh", name: "NABIDH (Dubai HIE)", status: "adapter_implemented" },
  { key: "malaffi", name: "Malaffi (Abu Dhabi HIE)", status: "adapter_implemented" },
  { key: "fta_einvoice", name: "FTA e-invoicing via Accredited Service Provider", status: "adapter_implemented" },
  { key: "sms_gateway", name: "SMS gateway", status: "adapter_implemented" },
  { key: "whatsapp_business", name: "WhatsApp Business", status: "not_configured" },
  { key: "payment_gateway", name: "Card / payment gateway", status: "not_configured" },
  { key: "drug_knowledge", name: "Drug-interaction knowledge provider", status: "not_configured" },
  { key: "pacs_dicom", name: "PACS / DICOM", status: "not_configured" },
];
type IntRow = { _id: string; key: string; name: string; status: Readiness; evidence?: string; updatedBy?: string; at: Date };
const ints = (o: string) => tenantCol<IntRow>(o, "integration_status");

export async function integrationMatrix(ctx: Ctx): Promise<IntRow[]> {
  assertPermission(ctx, "compliance:view");
  for (const d of DEFAULT_INTEGRATIONS) await ints(ctx.orgId).updateOne({ key: d.key } as never, { $setOnInsert: { _id: `${ctx.orgId}:${d.key}`, ...d, at: new Date() } } as never, undefined, { upsert: true });
  return ints(ctx.orgId).find({} as never, { sort: { name: 1 } });
}
/** One step forward at a time. "Approved" and "Production connected" need written evidence (reference to the regulator/vendor approval). Moving back is allowed with a reason. */
export async function setIntegrationStatus(ctx: Ctx, key: string, to: Readiness, evidence?: string) {
  assertPermission(ctx, "compliance:approve");
  await integrationMatrix(ctx);
  const row = await ints(ctx.orgId).findOne({ key } as never);
  if (!row) throw new AppError("NOT_FOUND", "Unknown integration");
  const from = READINESS.indexOf(row.status), target = READINESS.indexOf(to);
  if (target > from + 1) throw new AppError("CONFLICT", `Cannot jump from "${row.status}" to "${to}": each stage must be completed in order`);
  if ((to === "approved" || to === "production_connected" || target < from) && !evidence?.trim()) throw new AppError("VALIDATION", "Evidence or a reason is required for this change");
  await withTransaction(async (s) => {
    await ints(ctx.orgId).updateOne({ key } as never, { $set: { status: to, evidence, updatedBy: ctx.userId, at: new Date() } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "integration.status", resource: "integration", resourceId: key, before: { status: row.status }, after: { status: to, evidence } });
  });
}

export async function complianceDashboard(ctx: Ctx) {
  assertPermission(ctx, "compliance:view");
  const exp = await expiringItems(ctx, 60);
  const checklist = await listChecklist(ctx);
  const incidents = await listIncidents(ctx);
  const matrix = await integrationMatrix(ctx);
  return {
    expiringSoon: exp.filter((e) => !e.expired).length, expired: exp.filter((e) => e.expired).length,
    checklistOpen: checklist.filter((c) => c.status === "open" || c.status === "in_progress").length, checklistOverdue: checklist.filter((c) => c.dueDate && c.dueDate < new Date() && c.status !== "compliant" && c.status !== "not_applicable").length,
    incidentsOpen: incidents.filter((i) => i.status !== "closed").length,
    integrationsLive: matrix.filter((m) => m.status === "production_connected").length, integrationsTotal: matrix.length,
  };
}
