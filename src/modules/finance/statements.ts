import Decimal from "decimal.js";
import type { Decimal128 } from "mongodb";
import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { AppError } from "@/core/errors";
import { fromDecimal128, money, sum, toDecimal128 } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import type { Account } from "@/modules/ledger/accounts";
import type { Invoice, CreditNote } from "@/modules/billing/types";
import { pnl } from "@/modules/reports/pnl";

type GL = { _id: string; entryId: string; accountId: string; accountCode: string; accountType: string; date: Date; debit: Decimal128; credit: Decimal128; dims?: { branchId?: string } };
const gl = (o: string) => tenantCol<GL>(o, "gl_lines");

async function balances(ctx: Ctx, match: Record<string, unknown>) {
  const rows = await gl(ctx.orgId).aggregate<{ _id: { id: string; code: string; type: string }; debit: unknown; credit: unknown }>([
    { $match: match },
    { $group: { _id: { id: "$accountId", code: "$accountCode", type: "$accountType" }, debit: { $sum: "$debit" }, credit: { $sum: "$credit" } } },
  ]);
  const accs = new Map((await tenantCol<Account>(ctx.orgId, "accounts").find({} as never)).map((a) => [a._id, a]));
  return rows.map((r) => ({ code: r._id.code, name: accs.get(r._id.id)?.name ?? r._id.code, type: r._id.type, debit: fromDecimal128(r.debit as never), credit: fromDecimal128(r.credit as never) })).sort((a, b) => a.code.localeCompare(b.code));
}

export type BalanceSheet = {
  assets: { code: string; name: string; amount: Decimal }[]; liabilities: { code: string; name: string; amount: Decimal }[]; equity: { code: string; name: string; amount: Decimal }[];
  currentEarnings: Decimal; totalAssets: Decimal; totalLiabilitiesAndEquity: Decimal; balanced: boolean;
};

/** Position as at the end of `asOf` (inclusive). Current earnings = unclosed income less expenses. */
export async function balanceSheet(ctx: Ctx, f: { asOf?: Date } = {}): Promise<BalanceSheet> {
  assertPermission(ctx, "reports:view");
  const end = new Date((f.asOf ?? new Date()).getTime() + 1);
  const rows = await balances(ctx, { date: { $lt: end } });
  const pick = (type: string, sign: 1 | -1) => rows.filter((r) => r.type === type).map((r) => ({ code: r.code, name: r.name, amount: r.debit.minus(r.credit).times(sign) })).filter((r) => !r.amount.isZero());
  const assets = pick("asset", 1), liabilities = pick("liability", -1), equity = pick("equity", -1);
  const income = sum(rows.filter((r) => r.type === "income").map((r) => r.credit.minus(r.debit)));
  const expense = sum(rows.filter((r) => r.type === "expense").map((r) => r.debit.minus(r.credit)));
  const currentEarnings = income.minus(expense);
  const totalAssets = sum(assets.map((a) => a.amount));
  const tle = sum(liabilities.map((a) => a.amount)).plus(sum(equity.map((a) => a.amount))).plus(currentEarnings);
  return { assets, liabilities, equity, currentEarnings, totalAssets, totalLiabilitiesAndEquity: tle, balanced: totalAssets.equals(tle) };
}

const CASH_CODES = ["1000", "1010", "1015", "1016", "1020"]; // cash, bank, petty cash, savings, card clearing (in transit)

/** Direct-method cash flow. Each journal entry that touches cash is classified by the other accounts it involves. */
export async function cashFlow(ctx: Ctx, f: { from: Date; to: Date }) {
  assertPermission(ctx, "reports:view");
  const opening = (await balances(ctx, { date: { $lt: f.from }, accountCode: { $in: CASH_CODES } })).reduce((a, r) => a.plus(r.debit).minus(r.credit), money(0));
  const lines = await gl(ctx.orgId).find({ date: { $gte: f.from, $lt: f.to } } as never, { limit: 200000 });
  const byEntry = new Map<string, GL[]>();
  for (const l of lines) byEntry.set(l.entryId, [...(byEntry.get(l.entryId) ?? []), l]);
  const out = { operating: money(0), investing: money(0), financing: money(0) };
  for (const ls of byEntry.values()) {
    const cash = ls.filter((l) => CASH_CODES.includes(l.accountCode));
    if (!cash.length) continue;
    const net = cash.reduce((a, l) => a.plus(fromDecimal128(l.debit)).minus(fromDecimal128(l.credit)), money(0));
    if (net.isZero()) continue; // transfers between cash accounts
    const others = ls.filter((l) => !CASH_CODES.includes(l.accountCode));
    const kind = others.some((l) => l.accountType === "equity") ? "financing" : others.some((l) => l.accountCode.startsWith("15")) ? "investing" : "operating";
    out[kind] = out[kind].plus(net);
  }
  const netChange = out.operating.plus(out.investing).plus(out.financing);
  const closing = opening.plus(netChange);
  const actualClosing = (await balances(ctx, { date: { $lt: f.to }, accountCode: { $in: CASH_CODES } })).reduce((a, r) => a.plus(r.debit).minus(r.credit), money(0));
  return { opening, ...out, netChange, closing, reconciles: closing.equals(actualClosing) };
}

/** VAT position for a period from the ledger, plus taxable supplies by VAT classification from invoices (credit notes deducted). Classification is configuration pending tax review. */
export async function vatSummary(ctx: Ctx, f: { from: Date; to: Date }) {
  assertPermission(ctx, "reports:view");
  const rows = await balances(ctx, { date: { $gte: f.from, $lt: f.to }, accountCode: { $in: ["2100", "1600"] } });
  const net = (code: string) => rows.filter((r) => r.code === code).reduce((a, r) => a.plus(r.debit).minus(r.credit), money(0));
  const outputVat = net("2100").negated(), inputVat = net("1600");
  const invs = await tenantCol<Invoice>(ctx.orgId, "invoices").find({ createdAt: { $gte: f.from, $lt: f.to } } as never, { limit: 100000 });
  const cns = await tenantCol<CreditNote>(ctx.orgId, "credit_notes").find({ at: { $gte: f.from, $lt: f.to } } as never, { limit: 100000 });
  const credited = new Set(cns.map((c) => c.invoiceId));
  const taxCodes = new Map((await tenantCol<{ code: string; kind: string }>(ctx.orgId, "tax_codes").find({} as never)).map((t) => [t.code, t.kind]));
  const supplies: Record<string, Decimal> = {};
  for (const i of invs) {
    if (credited.has(i._id)) continue;
    for (const l of i.lines) {
      const k = taxCodes.get(l.taxCode) ?? "unclassified";
      supplies[k] = (supplies[k] ?? money(0)).plus(fromDecimal128(l.net));
    }
  }
  return { outputVat, inputVat, netPayable: outputVat.minus(inputVat), suppliesByClass: supplies, note: "Classification is configurable and must be reviewed by a UAE tax professional. This is not a VAT return." };
}

export type Budget = { _id: string; year: number; accountCode: string; amount: Decimal128; setBy: string; at: Date };

/** Annual budget per income/expense account. Setting it again replaces the figure (audited). */
export async function setBudget(ctx: Ctx, input: { year: number; accountCode: string; amount: string }): Promise<void> {
  assertPermission(ctx, "reports:create");
  const d = z.object({ year: z.number().int().min(2000).max(2100), accountCode: z.string(), amount: z.string().regex(/^\d+(\.\d{1,2})?$/) }).safeParse(input);
  if (!d.success) throw new AppError("VALIDATION", d.error.message);
  const acc = await tenantCol<Account>(ctx.orgId, "accounts").findOne({ code: d.data.accountCode } as never);
  if (!acc || !["income", "expense"].includes(acc.type)) throw new AppError("VALIDATION", "Budgets apply to income and expense accounts");
  await withTransaction(async (s) => {
    await tenantCol<Budget>(ctx.orgId, "budgets").updateOne({ year: d.data.year, accountCode: d.data.accountCode } as never,
      { $set: { amount: toDecimal128(money(d.data.amount)), setBy: ctx.userId, at: new Date() }, $setOnInsert: { _id: `${ctx.orgId}:${d.data.year}:${d.data.accountCode}` } } as never, s, { upsert: true });
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "budget.set", resource: "budget", resourceId: `${d.data.year}:${d.data.accountCode}`, after: d.data });
  });
}

/** Budget for the period is the annual figure pro-rated by days; actuals come from the ledger. */
export async function budgetVsActual(ctx: Ctx, f: { from: Date; to: Date }) {
  assertPermission(ctx, "reports:view");
  const year = new Date(f.from.getTime() + 4 * 3600_000).getUTCFullYear();
  const budgets = await tenantCol<Budget>(ctx.orgId, "budgets").find({ year } as never);
  const p = await pnl(ctx, f);
  const actual = new Map(p.byAccount.map((a) => [a.code, a.amount]));
  const days = (f.to.getTime() - f.from.getTime()) / 86400000;
  const yearDays = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
  const codes = new Set([...budgets.map((b) => b.accountCode), ...actual.keys()]);
  const rows = [...codes].sort().map((code) => {
    const b = budgets.find((x) => x.accountCode === code);
    const budget = b ? fromDecimal128(b.amount).times(days).div(yearDays).toDecimalPlaces(2) : money(0);
    const a = actual.get(code) ?? money(0);
    return { code, budget, actual: a, variance: a.minus(budget) };
  });
  return { rows, totalBudget: sum(rows.map((r) => r.budget)), totalActual: sum(rows.map((r) => r.actual)) };
}

/** Profit and loss per branch (ledger dimension). The branch figures add up to the consolidated figure. */
export async function branchProfitability(ctx: Ctx, f: { from: Date; to: Date }) {
  assertPermission(ctx, "reports:view");
  const branches = await tenantCol<{ _id: string; name: string }>(ctx.orgId, "branches").find({} as never);
  const rows = [];
  for (const b of branches) {
    const p = await pnl(ctx, { ...f, branchId: b._id });
    rows.push({ branchId: b._id, name: b.name, income: p.income, expense: p.expense, net: p.net });
  }
  const consolidated = await pnl(ctx, f);
  const unassignedNet = consolidated.net.minus(sum(rows.map((r) => r.net)));
  return { rows, consolidatedNet: consolidated.net, unassignedNet };
}

/** Pharmacy gross margin: pharmacy revenue less pharmacy cost of goods sold. */
export async function pharmacyMargin(ctx: Ctx, f: { from: Date; to: Date }) {
  assertPermission(ctx, "reports:view");
  const p = await pnl(ctx, f);
  const rev = p.byAccount.find((a) => a.code === "4300")?.amount ?? money(0);
  const cogs = p.byAccount.find((a) => a.code === "5400")?.amount ?? money(0);
  return { revenue: rev, cogs, grossMargin: rev.minus(cogs), marginPct: rev.isZero() ? null : rev.minus(cogs).div(rev).times(100).toNumber() };
}
