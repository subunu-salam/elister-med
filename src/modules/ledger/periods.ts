import type { ClientSession } from "mongodb";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { AppError } from "@/core/errors";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";

export type FiscalPeriod = { _id: string; year: number; month: number; status: "open" | "locked"; start: Date; end: Date };

/** Throws VALIDATION if no period covers the date, PERIOD_LOCKED if it is closed. */
export async function assertPeriodOpen(orgId: string, date: Date, s?: ClientSession): Promise<FiscalPeriod> {
  const p = await tenantCol<FiscalPeriod>(orgId, "fiscal_periods").findOne({ start: { $lte: date }, end: { $gt: date } } as never, s);
  if (!p) throw new AppError("VALIDATION", "No fiscal period covers this date");
  if (p.status === "locked") throw new AppError("PERIOD_LOCKED", `Fiscal period ${p.year}-${String(p.month).padStart(2, "0")} is locked`);
  return p;
}

export async function lockPeriod(ctx: Ctx, year: number, month: number): Promise<void> {
  assertPermission(ctx, "ledger:approve");
  await withTransaction(async (s) => {
    const res = await tenantCol<FiscalPeriod>(ctx.orgId, "fiscal_periods").updateOne({ year, month } as never, { $set: { status: "locked" } } as never, s);
    if (res.matchedCount === 0) throw new AppError("NOT_FOUND", "Fiscal period not found");
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "period.lock", resource: "fiscal_period", resourceId: `${year}-${month}` });
  });
}

export async function listPeriods(ctx: Ctx): Promise<FiscalPeriod[]> {
  assertPermission(ctx, "ledger:view");
  return tenantCol<FiscalPeriod>(ctx.orgId, "fiscal_periods").find({} as never, { sort: { year: 1, month: 1 } });
}
