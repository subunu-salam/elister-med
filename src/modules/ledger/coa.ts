import Decimal from "decimal.js";
import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { AppError } from "@/core/errors";
import { fromDecimal128, money } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import type { Account, AccountType } from "./accounts";

/** Chart of accounts management. Accounts are never deleted: they are deactivated, and only when their balance is zero. */
const FIRST: Record<AccountType, string> = { asset: "1", liability: "2", equity: "3", income: "4", expense: "5" };

export async function createAccount(ctx: Ctx, input: { code: string; name: string; type: AccountType }): Promise<Account> {
  assertPermission(ctx, "ledger:approve");
  const p = z.object({ code: z.string().regex(/^\d{4}$/, "Code is 4 digits"), name: z.string().min(3), type: z.enum(["asset", "liability", "equity", "income", "expense"]) }).safeParse(input);
  if (!p.success) throw new AppError("VALIDATION", p.error.issues[0].message);
  const d = p.data;
  if (!d.code.startsWith(FIRST[d.type])) throw new AppError("VALIDATION", `${d.type} accounts start with ${FIRST[d.type]}`);
  if (await tenantCol<Account>(ctx.orgId, "accounts").findOne({ code: d.code } as never)) throw new AppError("CONFLICT", `Account ${d.code} already exists`);
  const a: Account = { _id: `${ctx.orgId}:${d.code}`, code: d.code, name: d.name, type: d.type, normal: d.type === "asset" || d.type === "expense" ? "debit" : "credit", active: true };
  await withTransaction(async (s) => {
    await tenantCol<Account>(ctx.orgId, "accounts").insertOne(a, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "account.create", resource: "account", resourceId: a._id, after: { code: a.code, name: a.name } });
  });
  return a;
}

export async function renameAccount(ctx: Ctx, code: string, name: string): Promise<void> {
  assertPermission(ctx, "ledger:approve");
  if (name.trim().length < 3) throw new AppError("VALIDATION", "Name is too short");
  const r = await tenantCol<Account>(ctx.orgId, "accounts").updateOne({ code } as never, { $set: { name: name.trim() } } as never);
  if (r.matchedCount === 0) throw new AppError("NOT_FOUND", "Account not found");
}

export async function setAccountActive(ctx: Ctx, code: string, active: boolean): Promise<void> {
  assertPermission(ctx, "ledger:approve");
  const a = await tenantCol<Account>(ctx.orgId, "accounts").findOne({ code } as never);
  if (!a) throw new AppError("NOT_FOUND", "Account not found");
  if (!active) {
    if (a.system) throw new AppError("CONFLICT", "System accounts are used by automatic postings and cannot be deactivated");
    const [g] = await tenantCol(ctx.orgId, "gl_lines").aggregate<{ d: unknown; c: unknown }>([{ $match: { accountId: a._id } }, { $group: { _id: null, d: { $sum: "$debit" }, c: { $sum: "$credit" } } }]);
    if (g && !fromDecimal128(g.d as never).minus(fromDecimal128(g.c as never)).isZero()) throw new AppError("CONFLICT", "Account has a balance. Move it with a journal first.");
  }
  await tenantCol<Account>(ctx.orgId, "accounts").updateOne({ code } as never, { $set: { active } } as never);
}

export async function listAccounts(ctx: Ctx) {
  assertPermission(ctx, "ledger:view");
  const accs = await tenantCol<Account>(ctx.orgId, "accounts").find({} as never, { sort: { code: 1 }, limit: 1000 });
  const agg = await tenantCol(ctx.orgId, "gl_lines").aggregate<{ _id: string; d: unknown; c: unknown }>([{ $group: { _id: "$accountId", d: { $sum: "$debit" }, c: { $sum: "$credit" } } }]);
  const m = new Map(agg.map((r) => [r._id, fromDecimal128(r.d as never).minus(fromDecimal128(r.c as never))]));
  return accs.map((a) => ({ ...a, balance: m.get(a._id) ?? money(0) }));
}

export type GlRow = { date: Date; entryNo: number; memo: string; debit: Decimal; credit: Decimal; balance: Decimal };
/** Every posting to one account in a date range with a running balance (debit-positive) and the opening balance before it. */
export async function generalLedger(ctx: Ctx, f: { code: string; from: Date; to: Date }) {
  assertPermission(ctx, "ledger:view");
  const acc = await tenantCol<Account>(ctx.orgId, "accounts").findOne({ code: f.code } as never);
  if (!acc) throw new AppError("NOT_FOUND", "Account not found");
  const gl = tenantCol<{ entryId: string; entryNo: number; date: Date; debit: unknown; credit: unknown }>(ctx.orgId, "gl_lines");
  const [o] = await gl.aggregate<{ d: unknown; c: unknown }>([{ $match: { accountId: acc._id, date: { $lt: f.from } } }, { $group: { _id: null, d: { $sum: "$debit" }, c: { $sum: "$credit" } } }]);
  const opening = o ? fromDecimal128(o.d as never).minus(fromDecimal128(o.c as never)) : money(0);
  const lines = await gl.find({ accountId: acc._id, date: { $gte: f.from, $lt: f.to } } as never, { sort: { date: 1, entryNo: 1 }, limit: 5000 });
  const entries = await tenantCol<{ _id: string; memo: string }>(ctx.orgId, "journal_entries").find({ _id: { $in: [...new Set(lines.map((l) => l.entryId))] } } as never, { limit: 5000 });
  const memo = new Map(entries.map((e) => [e._id, e.memo]));
  let run = opening;
  const rows: GlRow[] = lines.map((l) => {
    const debit = fromDecimal128(l.debit as never), credit = fromDecimal128(l.credit as never);
    run = run.plus(debit).minus(credit);
    return { date: l.date, entryNo: l.entryNo, memo: memo.get(l.entryId) ?? "", debit, credit, balance: run };
  });
  return { account: acc, opening, rows, closing: run, truncated: lines.length >= 5000 };
}
