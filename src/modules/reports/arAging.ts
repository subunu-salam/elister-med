import Decimal from "decimal.js";
import { tenantCol } from "@/core/db";
import { fromDecimal128, money, sum } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import type { Invoice } from "@/modules/billing/types";

const BUCKETS: { label: string; max: number }[] = [
  { label: "0-30", max: 30 }, { label: "31-60", max: 60 }, { label: "61-90", max: 90 }, { label: "90+", max: Infinity },
];

export type ArAging = { buckets: { label: string; amount: Decimal; count: number }[]; total: Decimal };

/** Patient receivables by invoice age (days since invoice date). */
export async function arAging(ctx: Ctx, f: { asOf?: Date }): Promise<ArAging> {
  assertPermission(ctx, "reports:view");
  const asOf = f.asOf ?? new Date();
  const open = await tenantCol<Invoice>(ctx.orgId, "invoices").find({ status: { $in: ["finalized", "partially_paid"] } } as never);
  const buckets = BUCKETS.map((b) => ({ label: b.label, amount: money(0), count: 0 }));
  for (const inv of open) {
    const bal = fromDecimal128(inv.balance);
    if (bal.lte(0)) continue;
    const days = Math.floor((asOf.getTime() - inv.createdAt.getTime()) / 86400000);
    const i = BUCKETS.findIndex((b) => days <= b.max);
    buckets[i].amount = buckets[i].amount.plus(bal);
    buckets[i].count++;
  }
  return { buckets, total: sum(buckets.map((b) => b.amount)) };
}
