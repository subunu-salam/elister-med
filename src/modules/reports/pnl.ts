import Decimal from "decimal.js";
import { tenantCol } from "@/core/db";
import { fromDecimal128, money } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";

export type Range = { from: Date; to: Date; branchId?: string; departmentId?: string };

export function glMatch(f: Range): Record<string, unknown> {
  return {
    date: { $gte: f.from, $lt: f.to },
    ...(f.branchId ? { "dims.branchId": f.branchId } : {}),
    ...(f.departmentId ? { "dims.departmentId": f.departmentId } : {}),
  };
}

export type Pnl = { income: Decimal; expense: Decimal; net: Decimal; cogs: Decimal; grossProfit: Decimal; byAccount: { code: string; type: string; amount: Decimal }[] };

/** Profit and loss straight from gl_lines. Income = credit-debit, expense = debit-credit. */
export async function pnl(ctx: Ctx, f: Range): Promise<Pnl> {
  assertPermission(ctx, "reports:view");
  const rows = await tenantCol(ctx.orgId, "gl_lines").aggregate<{ _id: { code: string; type: string }; debit: unknown; credit: unknown }>([
    { $match: { ...glMatch(f), accountType: { $in: ["income", "expense"] } } },
    { $group: { _id: { code: "$accountCode", type: "$accountType" }, debit: { $sum: "$debit" }, credit: { $sum: "$credit" } } },
  ]);
  let income = money(0), expense = money(0), cogs = money(0);
  const byAccount = rows
    .map((r) => {
      const dr = fromDecimal128(r.debit as never), cr = fromDecimal128(r.credit as never);
      const amount = r._id.type === "income" ? cr.minus(dr) : dr.minus(cr);
      if (r._id.type === "income") income = income.plus(amount);
      else {
        expense = expense.plus(amount);
        if (r._id.code === "5400") cogs = cogs.plus(amount); // pharmacy cost of goods sold
      }
      return { code: r._id.code, type: r._id.type, amount };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
  return { income, expense, net: income.minus(expense), cogs, grossProfit: income.minus(cogs), byAccount };
}
