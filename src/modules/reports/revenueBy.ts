import Decimal from "decimal.js";
import { tenantCol } from "@/core/db";
import { fromDecimal128, money, sum } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { glMatch, type Range } from "./pnl";

export type RevenueBy = { rows: { key: string; amount: Decimal }[]; total: Decimal };

/** Revenue sliced by a ledger dimension. Lines without the dimension land in "unassigned" so the total always equals P&L income. */
export async function revenueBy(ctx: Ctx, f: Range & { by: "doctor" | "department" | "branch" }): Promise<RevenueBy> {
  assertPermission(ctx, "reports:view");
  const field = { doctor: "$dims.doctorId", department: "$dims.departmentId", branch: "$dims.branchId" }[f.by];
  const agg = await tenantCol(ctx.orgId, "gl_lines").aggregate<{ _id: string | null; debit: unknown; credit: unknown }>([
    { $match: { ...glMatch(f), accountType: "income" } },
    { $group: { _id: { $ifNull: [field, null] }, debit: { $sum: "$debit" }, credit: { $sum: "$credit" } } },
  ]);
  const rows = agg
    .map((r) => ({ key: r._id ?? "unassigned", amount: fromDecimal128(r.credit as never).minus(fromDecimal128(r.debit as never)) }))
    .sort((a, b) => b.amount.comparedTo(a.amount));
  return { rows, total: rows.length ? sum(rows.map((r) => r.amount)) : money(0) };
}
