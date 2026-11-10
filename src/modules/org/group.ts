import Decimal from "decimal.js";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { money, sum } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { pnl, type Range } from "@/modules/reports/pnl";

/**
 * Healthcare groups: a parent organisation can consolidate financial totals of member organisations only after EACH member's own
 * administrator has recorded an explicit sharing agreement. Without that, a member is listed as excluded and none of its data is read.
 * Only aggregate P&L figures are shared; no patient or clinical data crosses organisations.
 */
export type Group = { _id: string; name: string; members: string[]; createdBy: string; at: Date };
type Agreement = { _id: string; groupId: string; parentOrgId: string; agreedBy: string; at: Date; scope: "financial_totals" };

export async function createGroup(ctx: Ctx, input: { name: string; memberOrgIds: string[] }): Promise<Group> {
  assertPermission(ctx, "org:update");
  if (input.name.trim().length < 3 || !input.memberOrgIds.length) throw new AppError("VALIDATION", "Name and at least one member organisation required");
  if (input.memberOrgIds.includes(ctx.orgId)) throw new AppError("VALIDATION", "The parent organisation is included automatically");
  const g: Group = { _id: newId(), name: input.name, members: [...new Set(input.memberOrgIds)], createdBy: ctx.userId, at: new Date() };
  await withTransaction(async (s) => { await tenantCol<Group>(ctx.orgId, "groups").insertOne(g, s); await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "group.create", resource: "group", resourceId: g._id, after: { members: g.members } }); });
  return g;
}
/** Run by the MEMBER organisation's administrator, in their own organisation. */
export async function agreeToGroup(ctx: Ctx, parentOrgId: string, groupId: string) {
  assertPermission(ctx, "org:update");
  const g = await tenantCol<Group>(parentOrgId, "groups").findOne({ _id: groupId } as never);
  if (!g || !g.members.includes(ctx.orgId)) throw new AppError("NOT_FOUND", "No group invitation found for this organisation");
  await withTransaction(async (s) => {
    await tenantCol<Agreement>(ctx.orgId, "group_agreements").updateOne({ groupId } as never, { $setOnInsert: { _id: newId(), groupId, parentOrgId, agreedBy: ctx.userId, at: new Date(), scope: "financial_totals" } } as never, s, { upsert: true });
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "group.agree", resource: "group", resourceId: groupId, after: { parentOrgId } });
  });
}
export async function revokeGroupAgreement(ctx: Ctx, groupId: string) {
  assertPermission(ctx, "org:update");
  await tenantCol<Agreement>(ctx.orgId, "group_agreements").updateOne({ groupId } as never, { $set: { revoked: true } } as never);
}

export async function groupConsolidatedPnl(ctx: Ctx, groupId: string, range: Range) {
  assertPermission(ctx, "reports:view");
  const g = await tenantCol<Group>(ctx.orgId, "groups").findOne({ _id: groupId } as never);
  if (!g) throw new AppError("NOT_FOUND", "Group not found");
  const rows: { orgId: string; included: boolean; income: Decimal; expense: Decimal; net: Decimal }[] = [];
  const own = await pnl(ctx, range);
  rows.push({ orgId: ctx.orgId, included: true, income: own.income, expense: own.expense, net: own.net });
  for (const m of g.members) {
    const ag = await tenantCol<Agreement & { revoked?: boolean }>(m, "group_agreements").findOne({ groupId, parentOrgId: ctx.orgId } as never);
    if (!ag || ag.revoked) { rows.push({ orgId: m, included: false, income: money(0), expense: money(0), net: money(0) }); continue; }
    const p = await pnl({ ...ctx, orgId: m }, range); // read-only aggregate, authorised by the member's agreement
    rows.push({ orgId: m, included: true, income: p.income, expense: p.expense, net: p.net });
  }
  const inc = rows.filter((r) => r.included);
  return { rows, totalIncome: sum(inc.map((r) => r.income)), totalExpense: sum(inc.map((r) => r.expense)), totalNet: sum(inc.map((r) => r.net)), excluded: rows.filter((r) => !r.included).map((r) => r.orgId) };
}
