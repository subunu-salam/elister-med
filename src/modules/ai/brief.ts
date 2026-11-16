import "server-only";
import type { Decimal128 } from "mongodb";
import { getDb, tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { notifyUser } from "@/core/notify";
import { fromDecimal128 } from "@/core/money";
import { dubaiDayRange, dubaiParts } from "@/core/time";
import { AppError } from "@/core/errors";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { loadCtx } from "@/core/auth";
import type { Appointment } from "@/modules/appointments/schema";
import { listDoctors } from "@/modules/appointments/service";
import { executiveDashboard } from "@/modules/dashboard/executive";
import { pnl } from "@/modules/reports/pnl";
import { revenueBy } from "@/modules/reports/revenueBy";
import { askBooks, cfoInsights } from "@/modules/accounts/insights";
import { demandForecast } from "./service";
import { allowedSections, answerFromFacts, composeBrief, MALAYALAM, SECTION_KEYS, type Brief, type BriefFacts, type Lang, type SectionKey, type VoiceAnswer } from "./brief-core";
import { askExternal, voiceProvider } from "./voice-provider";

/**
 * Personal AI assistant. Gathers the figures for one day from the clinic's own data with the person's own permissions (so the super
 * admin's module access decides what the assistant may talk about), stores one snapshot per person per day so the call, the report page
 * and follow-up answers all quote the same numbers, and answers spoken follow-ups. Patient names are never put into the report:
 * receivables are named only for insurers and corporate clients.
 */
const DAY = 86400000;
const num = (x: unknown) => fromDecimal128(x as Decimal128).toNumber();
const clean = (n: string) => n.replace(/\s*\(.*?\)\s*/g, "").trim();
type Snapshot = { _id: string; userId: string; ymd: string; facts: BriefFacts; at: Date; listenedAt?: Date; calledAt?: Date; answeredAt?: Date; declinedAt?: Date };
const snaps = (orgId: string) => tenantCol<Snapshot>(orgId, "ai_briefs");

// ---------------------------------------------------------------- who may use it, and their settings

/** The assistant needs the dashboard plus at least one of: clinical figures (appointments) or money figures (reports), and the AI module. */
export const canBrief = (ctx: Ctx) => {
  const p = (x: string) => ctx.permissions.includes(x as never);
  return p("ai:view") && p("dashboard:view") && (p("reports:view") || p("appointments:view"));
};
export function assertBrief(ctx: Ctx) { if (!canBrief(ctx)) throw new AppError("FORBIDDEN", "Your access does not include the personal assistant"); }

export type AssistantPrefs = {
  enabled: boolean;
  /** Dubai time of the daily call, "HH:MM". After 15:00 the call reports on that day; before, on the day before. */
  callTime: string;
  /** 0 = Sunday. Days the call rings. */
  days: number[];
  lang: Lang;
  sections: SectionKey[];
  /** Set by the super admin: the person cannot change these. */
  lockedBy?: string;
};
export const DEFAULT_PREFS: AssistantPrefs = { enabled: true, callTime: "20:00", days: [0, 1, 2, 3, 4, 5, 6], lang: "en", sections: [...SECTION_KEYS] };
const prefsCol = (orgId: string) => tenantCol<AssistantPrefs & { _id: string; updatedAt: Date; updatedBy: string }>(orgId, "ai_assistant_prefs");

export async function getPrefs(orgId: string, userId: string): Promise<AssistantPrefs> {
  const p = await prefsCol(orgId).findOne({ _id: userId } as never);
  return p ? { enabled: p.enabled, callTime: p.callTime, days: p.days ?? DEFAULT_PREFS.days, lang: p.lang, sections: p.sections?.length ? p.sections : DEFAULT_PREFS.sections, lockedBy: p.lockedBy ?? undefined } : { ...DEFAULT_PREFS };
}

export function cleanPrefs(input: Partial<AssistantPrefs>, base: AssistantPrefs): AssistantPrefs {
  const time = typeof input.callTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.callTime) ? input.callTime : base.callTime;
  const sections = Array.isArray(input.sections) ? input.sections.filter((s): s is SectionKey => (SECTION_KEYS as readonly string[]).includes(s)) : base.sections;
  const days = Array.isArray(input.days) ? [...new Set(input.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : base.days;
  if (!sections.length) throw new AppError("VALIDATION", "Choose at least one part of the report");
  return { enabled: typeof input.enabled === "boolean" ? input.enabled : base.enabled, callTime: time, days, lang: input.lang === "ml" ? "ml" : input.lang === "en" ? "en" : base.lang, sections, lockedBy: base.lockedBy };
}

/** The person's own settings ("which details do I want, and when should Elister call me"). */
export async function savePrefs(ctx: Ctx, input: Partial<AssistantPrefs>) {
  assertBrief(ctx);
  const cur = await getPrefs(ctx.orgId, ctx.userId);
  if (cur.lockedBy) throw new AppError("FORBIDDEN", "Your assistant settings are managed by the administrator");
  const next = cleanPrefs(input, cur);
  await prefsCol(ctx.orgId).updateOne({ _id: ctx.userId } as never, { $set: { ...next, updatedAt: new Date(), updatedBy: ctx.userId } } as never, undefined, { upsert: true });
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "ai.assistant_prefs", resource: "ai", resourceId: ctx.userId, after: next }));
  return next;
}

/** Super admin sets (and optionally locks) someone's assistant. Authorisation is checked by the caller (admin module). */
export async function adminSavePrefs(admin: Ctx, userId: string, input: Partial<AssistantPrefs> & { lock?: boolean }) {
  const cur = await getPrefs(admin.orgId, userId);
  const next = cleanPrefs(input, cur);
  next.lockedBy = input.lock ? admin.userId : undefined;
  await prefsCol(admin.orgId).updateOne({ _id: userId } as never, { $set: { ...next, lockedBy: next.lockedBy ?? null, updatedAt: new Date(), updatedBy: admin.userId } } as never, undefined, { upsert: true });
  return next;
}

// ---------------------------------------------------------------- figures

function dubaiMonthStart(d: Date, back = 0): Date {
  const l = new Date(d.getTime() + 4 * 3600000);
  return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth() - back, 1) - 4 * 3600000);
}
const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" });
const dubaiHour = (d: Date) => Math.floor(dubaiParts(d).minutes / 60);

export async function gatherFacts(ctx: Ctx & { name?: string }, now = new Date()): Promise<BriefFacts> {
  assertBrief(ctx);
  const can = (p: string) => ctx.permissions.includes(p as never);
  const finance = can("reports:view"), clinical = can("appointments:view");
  const hour = dubaiHour(now);
  const period: BriefFacts["period"] = hour >= 15 ? "today" : "yesterday";

  const todayR = dubaiDayRange(now);
  const report = period === "today" ? { from: todayR.start, to: todayR.end } : { from: new Date(todayR.start.getTime() - DAY), to: todayR.start };
  const nextR = { from: report.to, to: new Date(report.to.getTime() + DAY) };
  const afterR = { from: nextR.to, to: new Date(nextR.to.getTime() + DAY) };
  const lastWeek = { from: new Date(report.from.getTime() - 7 * DAY), to: new Date(report.to.getTime() - 7 * DAY) };

  // Month to date up to the end of the reported day, against the same number of days of last month.
  const mtdFrom = dubaiMonthStart(new Date(report.from.getTime() + 3600000));
  const span = report.to.getTime() - mtdFrom.getTime();
  const prevFrom = dubaiMonthStart(new Date(mtdFrom.getTime() + DAY), 1);
  const prevTo = new Date(Math.min(prevFrom.getTime() + span, mtdFrom.getTime()));

  const appts = tenantCol<Appointment>(ctx.orgId, "appointments");
  const none = <T,>(v: T) => Promise.resolve(v);
  const [exec, lw, mtd, mtdPrev, byDoc, doctors, dayAppts, nextAppts, after, mtdAppts, org, openInv, forecast, cfo, newPts] = await Promise.all([
    finance ? executiveDashboard(ctx, report) : none(null),
    finance ? pnl(ctx, lastWeek) : none(null),
    finance ? pnl(ctx, { from: mtdFrom, to: report.to }) : none(null),
    finance ? pnl(ctx, { from: prevFrom, to: prevTo }) : none(null),
    finance ? revenueBy(ctx, { from: mtdFrom, to: report.to, by: "doctor" }) : none(null),
    clinical ? listDoctors(ctx) : none([]),
    clinical ? appts.find({ start: { $gte: report.from, $lt: report.to } } as never, { limit: 20000 }) : none([]),
    clinical ? appts.find({ start: { $gte: nextR.from, $lt: nextR.to }, status: { $ne: "cancelled" } } as never, { sort: { start: 1 }, limit: 20000 }) : none([]),
    clinical ? appts.count({ start: { $gte: afterR.from, $lt: afterR.to }, status: { $ne: "cancelled" } } as never) : none(0),
    clinical ? appts.count({ start: { $gte: mtdFrom, $lt: report.to }, status: { $ne: "cancelled" } } as never) : none(0),
    tenantCol<{ name: string }>(ctx.orgId, "orgs").findOne({ _id: ctx.orgId } as never),
    finance && can("billing:view") ? tenantCol<{ balance: Decimal128; createdAt: Date }>(ctx.orgId, "invoices").find({ status: { $in: ["finalized", "partially_paid"] } } as never, { limit: 50000 }) : none([]),
    clinical && can("ai:view") ? demandForecast(ctx).catch(() => null) : none(null),
    finance && can("ledger:view") ? cfoInsights(ctx, now).catch(() => null) : none(null),
    can("patients:view") ? tenantCol(ctx.orgId, "patients").count({ createdAt: { $gte: report.from, $lt: report.to } } as never) : none(0),
  ]);

  const staffNames = new Map<string, string>((await tenantCol<{ _id: string; name: string }>(ctx.orgId, "staff").find({} as never, { limit: 5000 })).map((s) => [s._id, clean(s.name)] as [string, string]));
  for (const d of doctors) staffNames.set(d._id, clean(d.name));
  const top = byDoc?.rows.filter((r) => r.key !== "unassigned").sort((a, b) => b.amount.comparedTo(a.amount))[0];

  const perDoc = new Map<string, number>();
  for (const a of nextAppts) if (a.doctorId) perDoc.set(a.doctorId, (perDoc.get(a.doctorId) ?? 0) + 1);
  const busiest = [...perDoc].sort((a, b) => b[1] - a[1])[0];

  const age = (d: Date) => (now.getTime() - d.getTime()) / DAY;
  const patientAr = openInv.reduce((s, i) => s + num(i.balance), 0);
  const over = (days: number) => openInv.filter((i) => age(i.createdAt) > days).reduce((s, i) => s + num(i.balance), 0);
  const nextDow = dubaiParts(nextR.from).dow;
  const tradeAr = cfo ? cfo.summary.receivables.toNumber() - patientAr : 0;

  return {
    ymd: dubaiParts(report.from).ymd, dow: dubaiParts(report.from).dow, period, hour,
    recipient: ctx.name ?? "", org: org?.name ?? "the clinic",
    scope: { clinical, finance },
    day: {
      appts: dayAppts.filter((a) => a.status !== "cancelled").length,
      seen: dayAppts.filter((a) => ["completed", "checked_in", "in_consult"].includes(a.status)).length,
      newPatients: exec?.current.newPatients ?? newPts,
      noShows: dayAppts.filter((a) => a.status === "no_show").length,
      cancelled: dayAppts.filter((a) => a.status === "cancelled").length,
      revenue: exec ? Number(exec.current.revenue) : 0, revenuePrev: exec ? Number(exec.previous.revenue) : null, revenueLastWeek: lw ? lw.income.toNumber() : null,
    },
    mtd: {
      revenue: mtd?.income.toNumber() ?? 0, revenuePrev: mtdPrev && span > 0 ? mtdPrev.income.toNumber() : null, netProfit: mtd?.net.toNumber() ?? 0, appts: mtdAppts,
      topDoctor: top && top.amount.gt(0) ? { name: staffNames.get(top.key) ?? "A doctor", amount: top.amount.toNumber() } : undefined,
    },
    ar: {
      patient: patientAr, over30: over(30), over90: over(90), trade: Math.max(0, tradeAr),
      tradeOverdue: cfo ? cfo.collections.filter((c) => c.daysOverdue > 0).reduce((s, c) => s + c.balance, 0) : 0,
      chase: cfo ? cfo.collections.filter((c) => c.balance > 0).slice(0, 3).map((c) => ({ name: c.customer, amount: c.balance, days: c.daysOverdue })) : [],
    },
    next: {
      when: period === "today" ? "tomorrow" : "today", dow: nextDow, booked: nextAppts.length,
      expected: forecast ? forecast.weekdayAverage[nextDow]?.expected ?? null : null,
      firstAt: nextAppts[0] ? hhmm(nextAppts[0].start) : undefined,
      busiest: busiest ? { name: staffNames.get(busiest[0]) ?? "One doctor", count: busiest[1] } : undefined,
      after,
    },
    cash: cfo ? {
      balance: cfo.summary.cash.toNumber(), score: cfo.health.score, grade: cfo.health.grade, runwayMonths: cfo.health.runwayMonths,
      breachWeek: cfo.forecast.breachWeek, lowest: cfo.forecast.lowest.amount, anomalies: cfo.anomalies.length,
      duplicates: cfo.duplicates.length, duplicateAmount: cfo.duplicates.reduce((s, d) => s + d.b.amount, 0),
    } : undefined,
  };
}

/** The snapshot for this person's current report (keyed by call date). Rebuilt when asked, or when an evening report was built in the morning. */
export async function getFacts(ctx: Ctx & { name?: string }, opts: { refresh?: boolean; now?: Date } = {}): Promise<{ facts: BriefFacts; at: Date }> {
  assertBrief(ctx);
  const now = opts.now ?? new Date();
  const ymd = dubaiParts(now).ymd, _id = `${ctx.userId}:${ymd}`;
  if (!opts.refresh) {
    const hit = await snaps(ctx.orgId).findOne({ _id } as never);
    // a morning snapshot is stale once the end-of-day report is due
    if (hit && !(hit.facts.period === "yesterday" && dubaiHour(now) >= 15)) return { facts: hit.facts, at: hit.at };
  }
  const facts = await gatherFacts(ctx, now);
  await snaps(ctx.orgId).updateOne({ _id } as never, { $set: { userId: ctx.userId, ymd, facts, at: now } } as never, undefined, { upsert: true });
  return { facts, at: now };
}

export type BriefPayloadServer = Brief & { generatedAt: Date; voice: ReturnType<typeof voiceProvider>; prefs: AssistantPrefs; allowed: SectionKey[] };
export async function getBrief(ctx: Ctx & { name?: string }, lang?: Lang, opts: { refresh?: boolean } = {}): Promise<BriefPayloadServer> {
  const [{ facts, at }, prefs] = await Promise.all([getFacts(ctx, opts), getPrefs(ctx.orgId, ctx.userId)]);
  return { ...composeBrief(facts, lang ?? prefs.lang, { sections: prefs.sections }), generatedAt: at, voice: voiceProvider(), prefs, allowed: allowedSections(facts) };
}

export async function markCall(ctx: Ctx, what: "listened" | "answered" | "declined") {
  const ymd = dubaiParts(new Date()).ymd;
  const field = { listened: "listenedAt", answered: "answeredAt", declined: "declinedAt" }[what];
  await snaps(ctx.orgId).updateOne({ _id: `${ctx.userId}:${ymd}` } as never, { $set: { [field]: new Date(), ...(what === "answered" ? { listenedAt: new Date() } : {}) } } as never);
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: `ai.call_${what}`, resource: "ai", resourceId: ymd, after: {} }));
}

/** Last 14 reports for the history strip. */
export async function briefHistory(ctx: Ctx) {
  assertBrief(ctx);
  const rows = await snaps(ctx.orgId).find({ userId: ctx.userId } as never, { sort: { ymd: -1 }, limit: 14 });
  return rows.map((r) => ({ ymd: r.ymd, revenue: r.facts.day?.revenue ?? 0, seen: r.facts.day?.seen ?? 0, listened: !!r.listenedAt }));
}

/** Short line for the incoming-call notification: who is calling and the headline figure. */
export async function callPreview(ctx: Ctx & { name?: string }) {
  const { facts } = await getFacts(ctx);
  const prefs = await getPrefs(ctx.orgId, ctx.userId);
  const b = composeBrief(facts, "en", { sections: prefs.sections });
  const issues = b.alerts.filter((a) => a.level !== "good").length;
  const head = facts.scope.finance ? `Revenue ${facts.period} AED ${Math.round(facts.day.revenue).toLocaleString("en-US")}` : `${facts.day.seen} patients seen ${facts.period}`;
  return { title: "Elister · Your personal AI assistant", body: `${b.title} is ready (${Math.max(1, Math.round(b.seconds / 60))} min). ${head}${issues ? ` · ${issues} to look at` : ""}`, ymd: dubaiParts(new Date()).ymd };
}

/**
 * A spoken or typed follow-up. Order: the report's own figures, then the books ("how much did we spend on rent last month"), then,
 * only when an external voice model has been approved and configured, a model answer grounded in the same aggregate figures.
 */
export async function askBrief(ctx: Ctx & { name?: string }, question: string, lang: Lang): Promise<VoiceAnswer & { source: "brief" | "books" | "model" | "none" }> {
  const q = question.trim().slice(0, 400);
  const { facts } = await getFacts(ctx);
  const a = answerFromFacts(q, facts, lang);
  const effective: Lang = MALAYALAM.test(q) ? "ml" : lang;
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "ai.brief_ask", resource: "ai", resourceId: a.intent, after: { handled: a.handled } }));
  if (a.handled) return { ...a, source: "brief" };
  const more = effective === "ml" ? " മറ്റെന്തെങ്കിലും?" : " Anything else?";

  if (ctx.permissions.includes("ledger:view") && effective === "en") {
    const b = await askBooks(ctx, q).catch(() => null);
    if (b && b.method !== "No matching question type.") return { ...a, answer: b.answer + more, handled: true, href: "/accounts/ai", source: "books" };
  }
  const m = await askExternal(q, facts, effective).catch(() => null);
  if (m) return { ...a, answer: m, handled: true, source: "model" };
  return {
    ...a, source: "none",
    answer: effective === "ml"
      ? "ക്ഷമിക്കണം, അത് എനിക്ക് മനസ്സിലായില്ല. വരുമാനം, രോഗികൾ, ബുക്കിംഗ്, കിട്ടാനുള്ള പണം, ക്യാഷ് എന്നിവയെക്കുറിച്ച് ചോദിക്കാം."
      : "Sorry, I can't answer that from the clinic's figures yet. Try asking about revenue, patients, bookings, money to collect, profit or cash.",
  };
}

// ---------------------------------------------------------------- the daily call

/**
 * Scheduled job (Vercel Cron). For every active member who can use the assistant and whose call time has passed today (Dubai), builds the
 * report with that member's own permissions, posts an in-app notification and rings their devices (web push). Each person is called at
 * most once a day.
 */
export async function placeDueCalls(now = new Date(), ring: (orgId: string, userId: string) => Promise<number>): Promise<{ called: number; failed: number }> {
  const db = await getDb();
  const members = await db.collection<{ userId: string; orgId: string; active: boolean }>("memberships").find({ active: true }).toArray();
  const names = new Map((await db.collection("user").find({}, { projection: { name: 1 } }).toArray()).map((u) => [String(u._id), String((u as { name?: string }).name ?? "")]));
  const hour = dubaiHour(now), dow = dubaiParts(now).dow, ymd = dubaiParts(now).ymd;
  let called = 0, failed = 0;
  for (const m of members) {
    try {
      const ctx = await loadCtx(m.userId);
      if (!ctx || !canBrief(ctx)) continue;
      const prefs = await getPrefs(ctx.orgId, ctx.userId);
      // Due once the call time has passed today. Works with an hourly cron (rings within the hour) or a single daily one (rings everyone due so far).
      if (!prefs.enabled || !prefs.days.includes(dow) || Number(prefs.callTime.slice(0, 2)) > hour) continue;
      const snap = await snaps(ctx.orgId).findOne({ _id: `${ctx.userId}:${ymd}` } as never);
      if (snap?.calledAt) continue;
      await callNow({ ...ctx, name: names.get(m.userId) ?? "" }, ring, now);
      called++;
    } catch (e) { failed++; console.error("assistant call failed", m.userId, e); }
  }
  return { called, failed };
}

/** Builds a fresh report and rings this person now (used by the schedule and by "Call me now"). */
export async function callNow(ctx: Ctx & { name?: string }, ring: (orgId: string, userId: string) => Promise<number>, now = new Date()) {
  assertBrief(ctx);
  await getFacts(ctx, { refresh: true, now });
  const p = await callPreview(ctx);
  const ymd = dubaiParts(now).ymd;
  await snaps(ctx.orgId).updateOne({ _id: `${ctx.userId}:${ymd}` } as never, { $set: { calledAt: now } } as never);
  await withTransaction((s) => notifyUser(ctx.orgId, ctx.userId, { type: "ai.brief", refType: "brief", refId: ymd, severity: "info", title: `📞 ${p.body}` }, s));
  const devices = await ring(ctx.orgId, ctx.userId);
  return { devices, preview: p };
}
