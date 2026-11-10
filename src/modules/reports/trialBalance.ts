import Decimal from "decimal.js";
import { tenantCol } from "@/core/db";
import { fromDecimal128, sum } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import type { Account } from "@/modules/ledger/accounts";

export type TbRow = { accountId: string; code: string; name: string; type: string; debit: Decimal; credit: Decimal; balance: Decimal };
export type TrialBalance = { rows: TbRow[]; totalDebit: Decimal; totalCredit: Decimal };

/** Computed straight from gl_lines. `from` is inclusive, `to` exclusive. */
export async function trialBalance(ctx: Ctx, f: { from?: Date; to?: Date; branchId?: string }): Promise<TrialBalance> {
  assertPermission(ctx, "ledger:view");
  const match: Record<string, unknown> = {};
  if (f.from || f.to) match.date = { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lt: f.to } : {}) };
  if (f.branchId) match["dims.branchId"] = f.branchId;
  const agg = await tenantCol(ctx.orgId, "gl_lines").aggregate<{ _id: string; debit: unknown; credit: unknown }>([
    { $match: match },
    { $group: { _id: "$accountId", debit: { $sum: "$debit" }, credit: { $sum: "$credit" } } },
  ]);
  const accs = await tenantCol<Account>(ctx.orgId, "accounts").find({});
  const byId = new Map(accs.map((a) => [a._id, a]));
  const rows = agg
    .map((r) => {
      const a = byId.get(r._id);
      const debit = fromDecimal128(r.debit as never), credit = fromDecimal128(r.credit as never);
      return { accountId: r._id, code: a?.code ?? "?", name: a?.name ?? "Unknown", type: a?.type ?? "?", debit, credit, balance: debit.minus(credit) };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
  return { rows, totalDebit: sum(rows.map((r) => r.debit)), totalCredit: sum(rows.map((r) => r.credit)) };
}
