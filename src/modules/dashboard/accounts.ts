import { tenantCol } from "@/core/db";
import { fromDecimal128, money, sum } from "@/core/money";
import { dubaiDayRange } from "@/core/time";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import type { Invoice } from "@/modules/billing/types";
import { pnl } from "@/modules/reports/pnl";
import { arAging } from "@/modules/reports/arAging";

/** Finance desk for one Dubai day. Everything is computed from the ledger and invoices. */
export async function accountsDashboard(ctx: Ctx, f: { day: Date }) {
  assertPermission(ctx, "dashboard:view");
  assertPermission(ctx, "ledger:view");
  const { start, end } = dubaiDayRange(f.day);
  const lines = await tenantCol<{ accountCode: string; debit: unknown; credit: unknown }>(ctx.orgId, "gl_lines").find(
    { date: { $gte: start, $lt: end }, accountCode: { $in: ["1000", "1010", "1020", "2100"] } } as never, { limit: 100000 });
  const net = (code: string) => sum(lines.filter((l) => l.accountCode === code).map((l) => fromDecimal128(l.debit as never).minus(fromDecimal128(l.credit as never))));
  const open = await tenantCol<Invoice>(ctx.orgId, "invoices").find({ status: { $in: ["finalized", "partially_paid"] } } as never);
  const day = await pnl(ctx, { from: start, to: end }).catch(() => null);
  const aging = await arAging(ctx, {}).catch(() => null);
  return {
    cashCollected: net("1000").toFixed(2),
    cardCollected: net("1020").toFixed(2),
    bankMovement: net("1010").toFixed(2),
    outputVat: net("2100").negated().toFixed(2),
    dailySales: day ? day.income.toFixed(2) : "0.00",
    dailyExpenses: day ? day.expense.toFixed(2) : "0.00",
    outstandingInvoices: open.filter((i) => fromDecimal128(i.balance).gt(0)).length,
    receivablesTotal: aging ? aging.total.toFixed(2) : money(0).toFixed(2),
    aging: aging ? aging.buckets.map((b) => ({ label: b.label, amount: b.amount.toFixed(2), count: b.count })) : [],
  };
}
