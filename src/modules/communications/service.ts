import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { contactInfo } from "@/modules/patients/service";
import { listAppointments, listDoctors } from "@/modules/appointments/service";

export type Channel = "sms" | "email" | "whatsapp" | "in_app";
export type Template = { _id: string; key: string; channel: Channel; language: "en" | "ar"; subject?: string; body: string; category: "transactional" | "marketing"; active: boolean };
export type Delivery = {
  _id: string; patientId: string; templateKey: string; channel: Channel; to: string; body: string; status: "sent" | "failed" | "dead" | "skipped_consent" | "skipped_optout";
  attempts: number; error?: string; dedupeKey?: string; gateway?: string; reason?: string; at: Date; lastAttemptAt?: Date;
};

const templates = (o: string) => tenantCol<Template>(o, "comm_templates");
const deliveries = (o: string) => tenantCol<Delivery>(o, "comm_deliveries");
const optOuts = (o: string) => tenantCol<{ _id: string; patientId: string; channel: Channel | "all"; at: Date }>(o, "comm_optouts");

export const ALLOWED_PLACEHOLDERS = ["patientName", "appointmentTime", "doctorName", "clinicName", "invoiceNumber", "amountDue", "link"] as const;
/** Insecure channels must not carry clinical detail. Templates containing these words are rejected for sms/email/whatsapp. */
const CLINICAL = /diagnos|test result|lab result|medicat|prescri|allerg|treatment for|condition/i;
const MAX_ATTEMPTS = 3;

/** Messaging boundary. Real SMS / WhatsApp Business / email gateways need approved accounts and are NOT connected; this sandbox sends nothing. */
export type Gateway = { name: string; mode: "sandbox" | "production"; send(channel: Channel, to: string, body: string): Promise<{ ok: boolean; error?: string }> };
export const sandboxGateway: Gateway = {
  name: "sandbox", mode: "sandbox",
  async send(_c, to) { return to.endsWith("0000") ? { ok: false, error: "Simulated gateway failure" } : { ok: true }; },
};

export async function upsertTemplate(ctx: Ctx, input: Omit<Template, "_id" | "active">): Promise<Template> {
  assertPermission(ctx, "communications:create");
  const d = z.object({ key: z.string().min(2), channel: z.enum(["sms", "email", "whatsapp", "in_app"]), language: z.enum(["en", "ar"]), subject: z.string().optional(), body: z.string().min(5), category: z.enum(["transactional", "marketing"]) }).safeParse(input);
  if (!d.success) throw new AppError("VALIDATION", d.error.message);
  const used = [...d.data.body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
  const bad = used.filter((u) => !(ALLOWED_PLACEHOLDERS as readonly string[]).includes(u));
  if (bad.length) throw new AppError("VALIDATION", `Unknown placeholder(s): ${bad.join(", ")}`);
  if (d.data.channel !== "in_app" && CLINICAL.test(d.data.body)) throw new AppError("VALIDATION", "Clinical detail must not be sent over SMS, email or WhatsApp. Use a neutral message that points to the secure portal.");
  if (d.data.category === "marketing" && d.data.channel !== "in_app" && !/stop|unsubscribe|opt.?out/i.test(d.data.body)) throw new AppError("VALIDATION", "Marketing messages must include opt-out wording");
  const t: Template = { _id: `${ctx.orgId}:${d.data.key}:${d.data.channel}:${d.data.language}`, ...d.data, active: true };
  await withTransaction(async (s) => {
    await templates(ctx.orgId).updateOne({ key: t.key, channel: t.channel, language: t.language } as never, { $set: { ...d.data, active: true }, $setOnInsert: { _id: t._id } } as never, s, { upsert: true });
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "template.upsert", resource: "comm_template", resourceId: t._id });
  });
  return t;
}
export async function listTemplates(ctx: Ctx) { assertPermission(ctx, "communications:view"); return templates(ctx.orgId).find({} as never, { sort: { key: 1 } }); }

export async function recordOptOut(ctx: Ctx, patientId: string, channel: Channel | "all") {
  assertPermission(ctx, "communications:create");
  await optOuts(ctx.orgId).updateOne({ patientId, channel } as never, { $setOnInsert: { _id: newId(), at: new Date() } } as never, undefined, { upsert: true });
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "comm.optout", resource: "patient", resourceId: patientId, after: { channel } }));
}

const render = (body: string, vars: Record<string, string>) => body.replace(/\{\{(\w+)\}\}/g, (_m, k) => vars[k] ?? "");

/** Consent, preference and opt-out are enforced here, before any gateway call. Every outcome (including skips) is logged. */
export async function sendMessage(ctx: Ctx, input: { patientId: string; templateKey: string; channel: Channel; language?: "en" | "ar"; vars?: Record<string, string>; dedupeKey?: string }): Promise<Delivery> {
  assertPermission(ctx, "communications:create");
  const gateway = sandboxGateway;
  if (input.dedupeKey) { const prior = await deliveries(ctx.orgId).findOne({ dedupeKey: input.dedupeKey } as never); if (prior) return prior; }
  const c = (await contactInfo(ctx, [input.patientId])).get(input.patientId);
  if (!c) throw new AppError("NOT_FOUND", "Patient not found");
  const lang = input.language ?? (c.preferredLanguage as "en" | "ar");
  const t = (await templates(ctx.orgId).findOne({ key: input.templateKey, channel: input.channel, language: lang, active: true } as never)) ?? (await templates(ctx.orgId).findOne({ key: input.templateKey, channel: input.channel, active: true } as never));
  if (!t) throw new AppError("NOT_FOUND", "Template not found for this channel");
  const to = input.channel === "email" ? c.email ?? "" : c.phone;
  const base: Omit<Delivery, "status" | "attempts"> = { _id: newId(), patientId: input.patientId, templateKey: t.key, channel: input.channel, to, body: render(t.body, { patientName: c.fullName, ...(input.vars ?? {}) }), dedupeKey: input.dedupeKey, gateway: gateway.name, at: new Date() };
  const log = async (d: Delivery) => { await withTransaction(async (s) => { await deliveries(ctx.orgId).insertOne(d, s); await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: `comm.${d.status}`, resource: "comm_delivery", resourceId: d._id, after: { channel: d.channel, template: d.templateKey, reason: d.reason } }); }); return d; };

  const opted = await optOuts(ctx.orgId).find({ patientId: input.patientId, channel: { $in: [input.channel, "all"] } } as never);
  if (opted.length) return log({ ...base, status: "skipped_optout", attempts: 0, reason: "Patient opted out" });
  const prefKey = input.channel === "email" ? "email" : input.channel === "in_app" ? "" : input.channel;
  if (prefKey && !c.commPrefs[prefKey]) return log({ ...base, status: "skipped_consent", attempts: 0, reason: `Patient has not agreed to ${input.channel} messages` });
  if (t.category === "marketing" && !c.commPrefs.marketing) return log({ ...base, status: "skipped_consent", attempts: 0, reason: "No marketing consent" });
  if (!to) return log({ ...base, status: "failed", attempts: 0, error: "No contact address on file" });

  const r = await gateway.send(input.channel, to, base.body);
  return log({ ...base, status: r.ok ? "sent" : "failed", attempts: 1, error: r.error, lastAttemptAt: new Date() });
}

/** Failed deliveries are retried up to 3 attempts, then dead-lettered for staff follow-up. */
export async function retryFailed(ctx: Ctx): Promise<{ retried: number; sent: number; dead: number }> {
  assertPermission(ctx, "communications:create");
  let retried = 0, sent = 0, dead = 0;
  for (const d of await deliveries(ctx.orgId).find({ status: "failed", attempts: { $gt: 0 } } as never, { limit: 500 })) {
    if (d.attempts >= MAX_ATTEMPTS) { await deliveries(ctx.orgId).updateOne({ _id: d._id } as never, { $set: { status: "dead" } } as never); dead++; continue; }
    const r = await sandboxGateway.send(d.channel, d.to, d.body);
    retried++;
    const attempts = d.attempts + 1;
    const status = r.ok ? "sent" : attempts >= MAX_ATTEMPTS ? "dead" : "failed";
    if (status === "sent") sent++; if (status === "dead") dead++;
    await deliveries(ctx.orgId).updateOne({ _id: d._id } as never, { $set: { status, attempts, error: r.error, lastAttemptAt: new Date() } } as never);
  }
  return { retried, sent, dead };
}

/** Reminders for booked appointments starting within the window. Idempotent: one reminder per appointment. Contains time and doctor only, no clinical detail. */
export async function scheduleAppointmentReminders(ctx: Ctx, opts: { withinHours: number; templateKey?: string } = { withinHours: 24 }) {
  assertPermission(ctx, "communications:create");
  const now = new Date(), to = new Date(now.getTime() + opts.withinHours * 3600_000);
  const appts = (await listAppointments(ctx, { from: now, to })).filter((a) => a.status === "booked");
  const docs = new Map((await listDoctors(ctx)).map((d) => [d._id, d.name]));
  const clinic = (await tenantCol<{ name: string }>(ctx.orgId, "orgs").findOne({ _id: ctx.orgId } as never))?.name ?? "the clinic";
  const out = { created: 0, skipped: 0 };
  for (const a of appts) {
    const before = await deliveries(ctx.orgId).findOne({ dedupeKey: `reminder:${a._id}` } as never);
    const d = await sendMessage(ctx, { patientId: a.patientId, templateKey: opts.templateKey ?? "appointment_reminder", channel: "sms", dedupeKey: `reminder:${a._id}`, vars: {
      appointmentTime: a.start.toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" }), doctorName: docs.get(a.doctorId) ?? "your doctor", clinicName: clinic } });
    if (before) out.skipped++; else out.created++;
    void d;
  }
  void to;
  return out;
}

export async function listDeliveries(ctx: Ctx, limit = 100) { assertPermission(ctx, "communications:view"); return deliveries(ctx.orgId).find({} as never, { sort: { at: -1 }, limit }); }
export async function deliveryStats(ctx: Ctx) {
  assertPermission(ctx, "communications:view");
  const all = await deliveries(ctx.orgId).find({} as never, { limit: 100000 });
  const c = (s: string) => all.filter((d) => d.status === s).length;
  return { sent: c("sent"), failed: c("failed"), dead: c("dead"), skippedConsent: c("skipped_consent"), skippedOptOut: c("skipped_optout") };
}
