import "server-only";
import type { Decimal128 } from "mongodb";
import { getDb, tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { notifyUser } from "@/core/notify";
import { fromDecimal128 } from "@/core/money";
import { dubaiDayRange, dubaiParts } from "@/core/time";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { loadCtx, type Membership } from "@/core/auth";
import { permissionsFor } from "@/core/rbac/roles";
import type { Appointment } from "@/modules/appointments/schema";
import { listDoctors } from "@/modules/appointments/service";
import { executiveDashboard } from "@/modules/dashboard/executive";
import { pnl } from "@/modules/reports/pnl";
import { revenueBy } from "@/modules/reports/revenueBy";
import { askBooks, cfoInsights } from "@/modules/accounts/insights";
import { demandForecast } from "./service";
import { answerFromFacts, composeBrief, MALAYALAM, type Brief, type BriefFacts, type Lang, type VoiceAnswer } from "./brief-core";
import { askExternal, voiceProvider } from "./voice-provider";

/**
 * Owner's daily voice brief. Gathers yesterday's and month-to-date figures from the clinic's own data with the signed-in user's
 * permissions, stores one snapshot per user per day (so the morning brief, the notification and the chat all quote the same numbers),
 * and answers spoken follow-ups. Patient names are never put into the brief: receivables are named only for insurers and corporate
 * clients. Read-only apart from the snapshot, the audit entry and the notification.
 */
const DAY = 86400000;
const num = (x: unknown) => fromDecimal128(x as Decimal128).toNumber();
const clean = (n: string) => n.replace(/\s*\(.*?\)\s*/g, "").trim();
type Snapshot = { _id: string; userId: string; ymd: string; facts: BriefFacts; at: Date; listenedAt?: Date };
const snaps = (orgId: string) => tenantCol<Snapshot>(orgId, "ai_briefs");

export const canBrief = (ctx: Ctx) => ctx.permissions.includes("dashboard:view") && ctx.permissions.includes("reports:view");

function dubaiMonthStart(d: Date, back = 0): Date {
  const l = new Date(d.getTime() + 4 * 3600000);
  return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth() - back, 1) - 4 * 3600000);
}
const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" });

export async function gatherFacts(ctx: Ctx & { name?: string }, now = new Date()): Promise<BriefFacts> {
  assertPermission(ctx, "dashboard:view");
  assertPermission(ctx, "reports:view");
  const today = dubaiDayRange(now);
  const yesterday = { from: new Date(today.start.getTime() - DAY), to: today.start };
  const lastWeek = { from: new Date(yesterday.from.getTime() - 7 * DAY), to: new Date(yesterday.to.getTime() - 7 * DAY) };

  // Month to date (to the start of today) against the same number of days of last month. On the 1st, report the whole of last month.
  let mtdFrom = dubaiMonthStart(now);
  if (mtdFrom.getTime() >= today.start.getTime()) mtdFrom = dubaiMonthStart(now, 1);
  const span = today.start.getTime() - mtdFrom.getTime();
  const prevFrom = dubaiMonthStart(new Date(mtdFrom.getTime() + DAY), 1);
  const prevTo = new Date(Math.min(prevFrom.getTime() + span, mtdFrom.getTime()));

  const appts = tenantCol<Appointment>(ctx.orgId, "appointments");
  const can = (p: string) => ctx.permissions.includes(p as never);

  const [exec, lw, mtd, mtdPrev, byDoc, staff, yAppts, todayAppts, tomorrow, mtdAppts, org, openInv, forecast, cfo] = await Promise.all([
    executiveDashboard(ctx, yesterday),
    pnl(ctx, lastWeek),
    pnl(ctx, { from: mtdFrom, to: today.start }),
    pnl(ctx, { from: prevFrom, to: prevTo }),
    revenueBy(ctx, { from: mtdFrom, to: today.start, by: "doctor" }),
    can("appointments:view") ? listDoctors(ctx) : Promise.resolve([]),
    appts.find({ start: { $gte: yesterday.from, $lt: yesterday.to } } as never, { limit: 20000 }),
    appts.find({ start: { $gte: today.start, $lt: today.end }, status: { $ne: "cancelled" } } as never, { sort: { start: 1 }, limit: 20000 }),
    appts.count({ start: { $gte: today.end, $lt: new Date(today.end.getTime() + DAY) }, status: { $ne: "cancelled" } } as never),
    appts.count({ start: { $gte: mtdFrom, $lt: today.start }, status: { $ne: "cancelled" } } as never),
    tenantCol<{ name: string }>(ctx.orgId, "orgs").findOne({ _id: ctx.orgId } as never),
    tenantCol<{ balance: Decimal128; createdAt: Date }>(ctx.orgId, "invoices").find({ status: { $in: ["finalized", "partially_paid"] } } as never, { limit: 50000 }),
    can("ai:view") ? demandForecast(ctx).catch(() => null) : Promise.resolve(null),
    can("ledger:view") ? cfoInsights(ctx, now).catch(() => null) : Promise.resolve(null),
  ]);

  const docName = new Map<string, string>(staff.map((d) => [d._id, clean(d.name)] as [string, string]));
  const allStaff = new Map<string, string>((await tenantCol<{ _id: string; name: string }>(ctx.orgId, "staff").find({} as never, { limit: 5000 })).map((s) => [s._id, clean(s.name)] as [string, string]));
  const top = byDoc.rows.filter((r) => r.key !== "unassigned").sort((a, b) => b.amount.comparedTo(a.amount))[0];

  const perDoc = new Map<string, number>();
  for (const a of todayAppts) if (a.doctorId) perDoc.set(a.doctorId, (perDoc.get(a.doctorId) ?? 0) + 1);
  const busiest = [...perDoc].sort((a, b) => b[1] - a[1])[0];

  const age = (d: Date) => (now.getTime() - d.getTime()) / DAY;
  const patientAr = openInv.reduce((s, i) => s + num(i.balance), 0);
  const over = (days: number) => openInv.filter((i) => age(i.createdAt) > days).reduce((s, i) => s + num(i.balance), 0);

  const dow = dubaiParts(now).dow;
  const tradeAr = cfo ? cfo.summary.receivables.toNumber() - patientAr : 0;
  return {
    ymd: dubaiParts(now).ymd, dow,
    recipient: ctx.name ?? "", org: org?.name ?? "the clinic",
    y: {
      appts: yAppts.filter((a) => a.status !== "cancelled").length,
      seen: yAppts.filter((a) => ["completed", "checked_in", "in_consult"].includes(a.status)).length,
      newPatients: exec.current.newPatients,
      noShows: yAppts.filter((a) => a.status === "no_show").length,
      cancelled: yAppts.filter((a) => a.status === "cancelled").length,
      revenue: Number(exec.current.revenue), revenuePrev: Number(exec.previous.revenue), revenueLastWeek: lw.income.toNumber(),
    },
    mtd: {
      revenue: mtd.income.toNumber(), revenuePrev: span > 0 ? mtdPrev.income.toNumber() : null, netProfit: mtd.net.toNumber(), appts: mtdAppts,
      topDoctor: top && top.amount.gt(0) ? { name: allStaff.get(top.key) ?? docName.get(top.key) ?? "A doctor", amount: top.amount.toNumber() } : undefined,
    },
    ar: {
      patient: patientAr, over30: over(30), over90: over(90),
      trade: Math.max(0, tradeAr),
      tradeOverdue: cfo ? cfo.collections.filter((c) => c.daysOverdue > 0).reduce((s, c) => s + c.balance, 0) : 0,
      chase: cfo ? cfo.collections.filter((c) => c.balance > 0).slice(0, 3).map((c) => ({ name: c.customer, amount: c.balance, days: c.daysOverdue })) : [],
    },
    today: {
      booked: todayAppts.length,
      expected: forecast ? forecast.weekdayAverage[dow]?.expected ?? null : null,
      firstAt: todayAppts[0] ? hhmm(todayAppts[0].start) : undefined,
      busiest: busiest ? { name: docName.get(busiest[0]) ?? allStaff.get(busiest[0]) ?? "One doctor", count: busiest[1] } : undefined,
      tomorrow,
    },
    cash: cfo ? {
      balance: cfo.summary.cash.toNumber(), score: cfo.health.score, grade: cfo.health.grade, runwayMonths: cfo.health.runwayMonths,
      breachWeek: cfo.forecast.breachWeek, lowest: cfo.forecast.lowest.amount, anomalies: cfo.anomalies.length,
      duplicates: cfo.duplicates.length, duplicateAmount: cfo.duplicates.reduce((s, d) => s + d.b.amount, 0),
    } : undefined,
  };
}

/** Today's snapshot for this user, built on first request (or when refresh is asked for). */
export async function getFacts(ctx: Ctx & { name?: string }, opts: { refresh?: boolean; now?: Date } = {}): Promise<{ facts: BriefFacts; at: Date }> {
  assertPermission(ctx, "dashboard:view");
  assertPermission(ctx, "reports:view");
  const now = opts.now ?? new Date();
  const ymd = dubaiParts(now).ymd, _id = `${ctx.userId}:${ymd}`;
  if (!opts.refresh) {
    const hit = await snaps(ctx.orgId).findOne({ _id } as never);
    if (hit) return { facts: hit.facts, at: hit.at };
  }
  const facts = await gatherFacts(ctx, now);
  await snaps(ctx.orgId).updateOne({ _id } as never, { $set: { userId: ctx.userId, ymd, facts, at: now } } as never, undefined, { upsert: true });
  return { facts, at: now };
}

export async function getBrief(ctx: Ctx & { name?: string }, lang: Lang, opts: { refresh?: boolean } = {}): Promise<Brief & { generatedAt: Date; voice: ReturnType<typeof voiceProvider> }> {
  const { facts, at } = await getFacts(ctx, opts);
  return { ...composeBrief(facts, lang), generatedAt: at, voice: voiceProvider() };
}

export async function markListened(ctx: Ctx) {
  const ymd = dubaiParts(new Date()).ymd;
  await snaps(ctx.orgId).updateOne({ _id: `${ctx.userId}:${ymd}` } as never, { $set: { listenedAt: new Date() } } as never);
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "ai.brief_listened", resource: "ai", resourceId: ymd, after: {} }));
}

/** Last 14 days of briefs for the history strip. */
export async function briefHistory(ctx: Ctx) {
  assertPermission(ctx, "reports:view");
  const rows = await snaps(ctx.orgId).find({ userId: ctx.userId } as never, { sort: { ymd: -1 }, limit: 14 });
  return rows.map((r) => ({ ymd: r.ymd, revenue: r.facts.y.revenue, seen: r.facts.y.seen, listened: !!r.listenedAt }));
}

/**
 * A spoken or typed follow-up. Order: the brief's own figures, then the books ("how much did we spend on rent last month"), then,
 * only when an external voice model has been approved and configured, a model answer grounded in the same aggregate figures.
 */
export async function askBrief(ctx: Ctx & { name?: string }, question: string, lang: Lang): Promise<VoiceAnswer & { source: "brief" | "books" | "model" | "none" }> {
  const q = question.trim().slice(0, 400);
  const { facts } = await getFacts(ctx);
  const a = answerFromFacts(q, facts, lang);
  const effective: Lang = MALAYALAM.test(q) ? "ml" : lang;
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "ai.brief_ask", resource: "ai", resourceId: a.intent, after: { handled: a.handled } }));
  if (a.handled) return { ...a, source: "brief" };

  if (ctx.permissions.includes("ledger:view") && effective === "en") {
    const b = await askBooks(ctx, q).catch(() => null);
    if (b && b.method !== "No matching question type.") return { ...a, answer: b.answer, handled: true, href: "/accounts/ai", source: "books" };
  }
  const m = await askExternal(q, facts, effective).catch(() => null);
  if (m) return { ...a, answer: m, handled: true, source: "model" };
  return {
    ...a, source: "none",
    answer: effective === "ml"
      ? "ക്ഷമിക്കണം, അത് എനിക്ക് മനസ്സിലായില്ല. വരുമാനം, രോഗികൾ, ഇന്നത്തെ ബുക്കിംഗ്, കിട്ടാനുള്ള പണം, ക്യാഷ് എന്നിവയെക്കുറിച്ച് ചോദിക്കാം."
      : "Sorry, I can't answer that from the clinic's figures yet. Try asking about revenue, patients, today's bookings, money to collect, profit or cash.",
  };
}

/**
 * Morning job (Vercel cron, ~08:00 Dubai). For every active member whose role can see the brief, builds today's snapshot with that
 * member's own permissions and drops an in-app notification linking to the player. Safe to run twice: the snapshot is upserted and
 * the notification is sent once per user per day.
 */
export async function publishDailyBriefs(now = new Date()): Promise<{ users: number; failed: number }> {
  const db = await getDb();
  const members = await db.collection<Membership>("memberships").find({ active: true }).toArray();
  const eligible = members.filter((m) => { const p = permissionsFor(m.roles); return p.includes("dashboard:view") && p.includes("reports:view"); });
  const names = new Map((await db.collection("user").find({}, { projection: { name: 1 } }).toArray()).map((u) => [String(u._id), String((u as { name?: string }).name ?? "")]));
  const ymd = dubaiParts(now).ymd;
  let users = 0, failed = 0;
  for (const m of eligible) {
    try {
      const ctx = await loadCtx(m.userId);
      if (!ctx) continue;
      const { facts } = await getFacts({ ...ctx, name: names.get(m.userId) ?? "" }, { refresh: true, now });
      const sent = await tenantCol(ctx.orgId, "notifications").count({ userId: ctx.userId, type: "ai.brief", refId: ymd } as never);
      if (!sent) {
        const b = composeBrief(facts, "en");
        const issues = b.alerts.filter((x) => x.level !== "good").length;
        await withTransaction((s) => notifyUser(ctx.orgId, ctx.userId, {
          type: "ai.brief", refType: "brief", refId: ymd, severity: b.alerts.some((x) => x.level === "critical") ? "warn" : "info",
          title: `Your ${Math.max(1, Math.round(b.seconds / 60))}-minute brief is ready · revenue yesterday ${Math.round(facts.y.revenue).toLocaleString("en-US")} AED${issues ? ` · ${issues} to look at` : ""}`,
        }, s));
      }
      users++;
    } catch (e) { failed++; console.error("daily brief failed", m.userId, e); }
  }
  return { users, failed };
}
