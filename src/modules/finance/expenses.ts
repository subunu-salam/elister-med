import type { Decimal128 } from "mongodb";
import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { fromDecimal128, money, round2, toDecimal128 } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { accountBySystem } from "@/modules/ledger/accounts";
import { postJournalSystem } from "@/modules/ledger/journal";
import { NON_DEDUCTIBLE_PCT, type TreatmentCode } from "@/modules/tax/corporateTax";

/**
 * Direct operating expenses (rent, utilities, marketing, licences, client entertainment, fines...) with VAT and a corporate-tax treatment.
 * Entertainment and non-deductible items feed the corporate tax add-backs automatically. Input VAT on entertainment is not recoverable,
 * so it is expensed with the item.
 */
export type Expense = {
  _id: string; date: Date; category: string; categoryName: string; vendor: string; reference?: string; description: string; net: Decimal128; vat: Decimal128; irrecoverableVat: Decimal128; total: Decimal128;
  paidFrom: "bank" | "cash" | "petty_cash" | "card_clearing"; treatment: TreatmentCode; journalEntryId: string; by: string; at: Date; reversed?: boolean;
};
const expenses = (o: string) => tenantCol<Expense>(o, "expenses");
const amt = z.string().regex(/^\d+(\.\d{1,2})?$/, "Amount must be a positive number with at most 2 decimals");

export async function recordExpense(ctx: Ctx, input: {
  date?: Date; category: string; vendor: string; reference?: string; description: string; net: string; vatRate?: "STD" | "ZERO" | "EXEMPT"; paidFrom: Expense["paidFrom"]; treatment?: TreatmentCode; idempotencyKey: string;
}): Promise<Expense> {
  assertPermission(ctx, "ledger:create");
  const p = z.object({ category: z.string().regex(/^5\d{3}$/, "Choose an expense account (5xxx)"), vendor: z.string().min(2), description: z.string().min(3), net: amt, vatRate: z.enum(["STD", "ZERO", "EXEMPT"]).default("STD"), paidFrom: z.enum(["bank", "cash", "petty_cash", "card_clearing"]), treatment: z.enum(["deductible", "entertainment_50", "non_deductible"]).default("deductible"), idempotencyKey: z.string().min(1) }).safeParse(input);
  if (!p.success) throw new AppError("VALIDATION", p.error.message);
  const d = p.data;
  const net = money(d.net);
  if (net.lte(0)) throw new AppError("VALIDATION", "Amount must be greater than zero");
  const prior = await expenses(ctx.orgId).findOne({ idempotencyKey: d.idempotencyKey } as never);
  if (prior) return prior;
  const acc = await tenantCol<{ _id: string; name: string; type: string; active: boolean }>(ctx.orgId, "accounts").findOne({ code: d.category } as never);
  if (!acc || acc.type !== "expense" || !acc.active) throw new AppError("VALIDATION", "Choose an active expense account");
  const vat = d.vatRate === "STD" ? round2(net.times(5).div(100)) : money(0);
  const recoverable = d.treatment !== "entertainment_50" && vat.gt(0);
  const irrecoverable = vat.gt(0) && !recoverable ? vat : money(0);
  const total = net.plus(vat);
  return withTransaction(async (s) => {
    const id = newId();
    const je = await postJournalSystem(ctx, {
      date: input.date ?? new Date(), memo: `Expense: ${d.description} (${d.vendor})`, sourceRef: { type: "expense", id }, idempotencyKey: `expense:${d.idempotencyKey}`,
      lines: [
        { accountId: `${ctx.orgId}:${d.category}`, debit: net.plus(irrecoverable).toFixed(2) },
        ...(recoverable ? [{ accountId: (await accountBySystem(ctx.orgId, "vat_input"))._id, debit: vat.toFixed(2) }] : []),
        { accountId: (await accountBySystem(ctx.orgId, d.paidFrom))._id, credit: total.toFixed(2) },
      ],
    }, s);
    const e: Expense = { _id: id, date: input.date ?? new Date(), category: d.category, categoryName: acc.name, vendor: d.vendor, reference: input.reference, description: d.description, net: toDecimal128(net), vat: toDecimal128(vat), irrecoverableVat: toDecimal128(irrecoverable), total: toDecimal128(total), paidFrom: d.paidFrom, treatment: d.treatment, journalEntryId: je._id, by: ctx.userId, at: new Date() };
    await expenses(ctx.orgId).insertOne({ ...e, idempotencyKey: d.idempotencyKey } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "expense.record", resource: "expense", resourceId: id, after: { total: total.toFixed(2), treatment: d.treatment, nonDeductiblePct: NON_DEDUCTIBLE_PCT[d.treatment] } });
    return e;
  });
}

export async function listExpenses(ctx: Ctx, f: { from?: Date; to?: Date } = {}) {
  assertPermission(ctx, "ledger:view");
  return expenses(ctx.orgId).find({ ...(f.from || f.to ? { date: { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lt: f.to } : {}) } } : {}) } as never, { sort: { date: -1 }, limit: 300 });
}
export const expenseTotal = (e: Expense) => fromDecimal128(e.total);
