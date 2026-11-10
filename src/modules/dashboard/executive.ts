import { tenantCol } from "@/core/db";
import { fromDecimal128, money, sum } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import type { Appointment } from "@/modules/appointments/schema";
import type { Invoice } from "@/modules/billing/types";
import { pnl, type Range } from "@/modules/reports/pnl";
import { revenueBy } from "@/modules/reports/revenueBy";

export type Kpis = {
  appointments: number;
  newPatients: number;
  returningPatients: number;
  revenue: string;
  operatingExpenses: string;
  grossProfit: string;
  netProfit: string;
  outstandingReceivables: string;
  cancellationRate: number;
  noShowRate: number;
  avgWaitMinutes: number;
  revenueByDoctor: { key: string; amount: string }[];
  revenueByDepartment: { key: string; amount: string }[];
};

const rate = (n: number, d: number) => (d === 0 ? 0 : n / d);

async function kpis(ctx: Ctx, f: Range): Promise<Kpis> {
  const range = { $gte: f.from, $lt: f.to };
  const apptFilter = { start: range, ...(f.branchId ? { branchId: f.branchId } : {}) };
  const appts = await tenantCol<Appointment>(ctx.orgId, "appointments").find(apptFilter as never, { limit: 100000 });
  const patientIds = [...new Set(appts.map((a) => a.patientId))];
  const patients = await tenantCol<{ _id: string; createdAt: Date }>(ctx.orgId, "patients").find({ _id: { $in: patientIds } } as never);
  const newInRange = await tenantCol(ctx.orgId, "patients").count({ createdAt: range } as never);
  const returning = patients.filter((p) => p.createdAt < f.from).length;

  const p = await pnl(ctx, f);
  const byDoc = await revenueBy(ctx, { ...f, by: "doctor" });
  const byDept = await revenueBy(ctx, { ...f, by: "department" });

  const label = new Map<string, string>([
    ...(await tenantCol<{ _id: string; name: string }>(ctx.orgId, "staff").find({} as never)).map((d) => [d._id, d.name.replace(/\s*\(.*?\)\s*/g, "").trim()] as [string, string]),
    ...(await tenantCol<{ _id: string; name: string }>(ctx.orgId, "departments").find({} as never)).map((d) => [d._id, d.name] as [string, string]),
  ]);
  const named = (rows: { key: string; amount: import("decimal.js").default }[]) => rows.map((r) => ({ key: label.get(r.key) ?? (r.key === "unassigned" ? "Unassigned" : r.key), amount: r.amount.toFixed(2) }));

  const open = await tenantCol<Invoice>(ctx.orgId, "invoices").find({ status: { $in: ["finalized", "partially_paid"] } } as never);
  const receivables = sum(open.map((i) => fromDecimal128(i.balance)));

  const tokens = await tenantCol<{ checkedInAt: Date; startedAt?: Date }>(ctx.orgId, "queue_tokens").find(
    { checkedInAt: range, startedAt: { $exists: true } } as never, { limit: 100000 });
  const waits = tokens.map((t) => (t.startedAt!.getTime() - t.checkedInAt.getTime()) / 60000);

  return {
    appointments: appts.length,
    newPatients: newInRange,
    returningPatients: returning,
    revenue: p.income.toFixed(2),
    operatingExpenses: p.expense.minus(p.cogs).toFixed(2),
    grossProfit: p.grossProfit.toFixed(2),
    netProfit: p.net.toFixed(2),
    outstandingReceivables: receivables.toFixed(2),
    cancellationRate: rate(appts.filter((a) => a.status === "cancelled").length, appts.length),
    noShowRate: rate(appts.filter((a) => a.status === "no_show").length, appts.length),
    avgWaitMinutes: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0,
    revenueByDoctor: named(byDoc.rows),
    revenueByDepartment: named(byDept.rows),
  };
}

type Delta = { abs: string; pct: number | null };
const MONEY_KEYS = ["revenue", "operatingExpenses", "grossProfit", "netProfit", "outstandingReceivables"] as const;
const COUNT_KEYS = ["appointments", "newPatients", "returningPatients", "avgWaitMinutes", "cancellationRate", "noShowRate"] as const;

export async function executiveDashboard(ctx: Ctx, f: Range) {
  assertPermission(ctx, "dashboard:view");
  assertPermission(ctx, "reports:view");
  const len = f.to.getTime() - f.from.getTime();
  const prevRange: Range = { ...f, from: new Date(f.from.getTime() - len), to: f.from };
  const [current, previous] = await Promise.all([kpis(ctx, f), kpis(ctx, prevRange)]);

  const delta = {} as Record<(typeof MONEY_KEYS)[number] | (typeof COUNT_KEYS)[number], Delta>;
  for (const k of MONEY_KEYS) {
    const c = money(current[k]), p = money(previous[k]);
    delta[k] = { abs: c.minus(p).toFixed(2), pct: p.isZero() ? null : c.minus(p).div(p.abs()).times(100).toNumber() };
  }
  for (const k of COUNT_KEYS) {
    const c = current[k], p = previous[k];
    delta[k] = { abs: String(c - p), pct: p === 0 ? null : ((c - p) / Math.abs(p)) * 100 };
  }
  return { range: f, previousRange: prevRange, current, previous, delta };
}
