import Decimal from "decimal.js";
import type { Decimal128 } from "mongodb";
import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { fromDecimal128, money, toDecimal128 } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { accountBySystem, type Account } from "@/modules/ledger/accounts";
import { postJournalSystem } from "@/modules/ledger/journal";
import { cashTakenBy } from "@/modules/billing/payment";

const amount = z.string().regex(/^\d+(\.\d{1,2})?$/);
const v = <T>(r: { success: true; data: T } | { success: false; error: { message: string } }): T => { if (!r.success) throw new AppError("VALIDATION", r.error.message); return r.data; };

// ---------- Cash register (drawer) ----------
export type RegisterSession = {
  _id: string; cashierId: string; branchId: string; openedAt: Date; openingFloat: Decimal128; status: "open" | "closed";
  closedAt?: Date; counted?: Decimal128; expected?: Decimal128; variance?: Decimal128; journalEntryId?: string; note?: string;
};
const sessions = (o: string) => tenantCol<RegisterSession>(o, "register_sessions");

export async function openRegister(ctx: Ctx, input: { openingFloat: string }): Promise<RegisterSession> {
  assertPermission(ctx, "billing:create");
  const d = v(z.object({ openingFloat: amount }).safeParse(input));
  const s0: RegisterSession = { _id: newId(), cashierId: ctx.userId, branchId: ctx.branchId, openedAt: new Date(), openingFloat: toDecimal128(money(d.openingFloat)), status: "open" };
  try {
    await withTransaction(async (s) => {
      if (await sessions(ctx.orgId).count({ cashierId: ctx.userId, status: "open" } as never, s)) throw new AppError("CONFLICT", "You already have an open cash drawer");
      await sessions(ctx.orgId).insertOne(s0, s);
      await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "register.open", resource: "register_session", resourceId: s0._id, after: { float: d.openingFloat } });
    });
  } catch (e) { if ((e as { code?: number }).code === 11000) throw new AppError("CONFLICT", "You already have an open cash drawer"); throw e; }
  return s0;
}

/** Closing compares counted cash with opening float + cash taken (net of cash refunds). Any variance posts to Cash Over and Short. */
export async function closeRegister(ctx: Ctx, input: { counted: string; note?: string }): Promise<RegisterSession> {
  assertPermission(ctx, "billing:create");
  const counted = money(v(z.object({ counted: amount }).safeParse(input)).counted);
  const open = (await sessions(ctx.orgId).find({ cashierId: ctx.userId, status: "open" } as never, { limit: 1 }))[0];
  if (!open) throw new AppError("NOT_FOUND", "No open cash drawer");
  const now = new Date();
  const taken = await cashTakenBy(ctx, ctx.userId, open.openedAt, now);
  const expected = fromDecimal128(open.openingFloat).plus(taken.net);
  const variance = counted.minus(expected);
  if (!variance.isZero() && !input.note?.trim()) throw new AppError("VALIDATION", "A note explaining the variance is required");
  return withTransaction(async (s) => {
    let je: string | undefined;
    if (!variance.isZero()) {
      const cash = (await accountBySystem(ctx.orgId, "cash"))._id, over = (await accountBySystem(ctx.orgId, "cash_variance"))._id;
      const shortage = variance.isNegative();
      const posted = await postJournalSystem(ctx, {
        date: now, memo: `Cash drawer variance: ${input.note}`, sourceRef: { type: "register_close", id: open._id }, idempotencyKey: `regclose:${open._id}`,
        lines: [{ accountId: shortage ? over : cash, debit: variance.abs().toFixed(2) }, { accountId: shortage ? cash : over, credit: variance.abs().toFixed(2) }],
      }, s);
      je = posted._id;
    }
    const res = await sessions(ctx.orgId).updateOne({ _id: open._id, status: "open" } as never, {
      $set: { status: "closed", closedAt: now, counted: toDecimal128(counted), expected: toDecimal128(expected), variance: toDecimal128(variance), note: input.note, ...(je ? { journalEntryId: je } : {}) },
    } as never, s);
    if (res.matchedCount === 0) throw new AppError("CONFLICT", "Drawer already closed");
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "register.close", resource: "register_session", resourceId: open._id, after: { counted: counted.toFixed(2), expected: expected.toFixed(2), variance: variance.toFixed(2) } });
    return { ...open, status: "closed", closedAt: now, counted: toDecimal128(counted), expected: toDecimal128(expected), variance: toDecimal128(variance) };
  });
}
export async function listRegisterSessions(ctx: Ctx) { assertPermission(ctx, "billing:view"); return sessions(ctx.orgId).find({} as never, { sort: { openedAt: -1 }, limit: 100 }); }

// ---------- Transfers and petty cash ----------
const CASH_SYSTEMS = ["cash", "bank", "bank_savings", "petty_cash"] as const;

/** Move funds between cash/bank accounts (e.g. banking the day's cash). Idempotent per key. */
export async function transferFunds(ctx: Ctx, input: { from: (typeof CASH_SYSTEMS)[number]; to: (typeof CASH_SYSTEMS)[number]; amount: string; idempotencyKey: string; memo?: string }) {
  assertPermission(ctx, "ledger:create");
  const d = v(z.object({ from: z.enum(CASH_SYSTEMS), to: z.enum(CASH_SYSTEMS), amount, idempotencyKey: z.string().min(1), memo: z.string().optional() }).safeParse(input));
  if (d.from === d.to) throw new AppError("VALIDATION", "Source and destination must differ");
  if (money(d.amount).lte(0)) throw new AppError("VALIDATION", "Amount must be positive");
  return withTransaction(async (s) => postJournalSystem(ctx, {
    date: new Date(), memo: d.memo ?? `Transfer ${d.from} -> ${d.to}`, sourceRef: { type: "transfer", id: d.idempotencyKey }, idempotencyKey: `transfer:${d.idempotencyKey}`,
    lines: [{ accountId: (await accountBySystem(ctx.orgId, d.to))._id, debit: d.amount }, { accountId: (await accountBySystem(ctx.orgId, d.from))._id, credit: d.amount }],
  }, s));
}

export async function pettyCashExpense(ctx: Ctx, input: { expenseCode: string; amount: string; description: string; idempotencyKey: string }) {
  assertPermission(ctx, "ledger:create");
  const d = v(z.object({ expenseCode: z.string(), amount, description: z.string().min(3), idempotencyKey: z.string().min(1) }).safeParse(input));
  return withTransaction(async (s) => {
    const exp = await tenantCol<Account>(ctx.orgId, "accounts").findOne({ code: d.expenseCode, active: true } as never, s);
    if (!exp || exp.type !== "expense") throw new AppError("VALIDATION", "Choose an active expense account");
    return postJournalSystem(ctx, {
      date: new Date(), memo: `Petty cash: ${d.description}`, sourceRef: { type: "petty_cash", id: d.idempotencyKey }, idempotencyKey: `petty:${d.idempotencyKey}`,
      lines: [{ accountId: exp._id, debit: d.amount }, { accountId: (await accountBySystem(ctx.orgId, "petty_cash"))._id, credit: d.amount }],
    }, s);
  });
}

// ---------- Bank statements and reconciliation ----------
export type BankTx = { _id: string; account: "bank" | "bank_savings"; date: Date; description: string; amount: Decimal128; reference?: string; status: "unmatched" | "matched"; glLineId?: string; importId: string };
const bankTx = (o: string) => tenantCol<BankTx>(o, "bank_transactions");

/** Statement import. Amount is signed: positive = money in. Lines already imported (same date, amount, reference) are skipped, so re-importing is safe. */
export async function importBankStatement(ctx: Ctx, input: { account: "bank" | "bank_savings"; lines: { date: string; description: string; amount: string; reference?: string }[] }) {
  assertPermission(ctx, "ledger:create");
  const d = v(z.object({ account: z.enum(["bank", "bank_savings"]), lines: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), description: z.string(), amount: z.string().regex(/^-?\d+(\.\d{1,2})?$/), reference: z.string().optional() })).min(1) }).safeParse(input));
  const importId = newId();
  let added = 0, skipped = 0;
  for (const l of d.lines) {
    const date = new Date(`${l.date}T00:00:00+04:00`);
    const dup = await bankTx(ctx.orgId).findOne({ account: d.account, date, amount: toDecimal128(money(l.amount)), reference: l.reference ?? null } as never);
    if (dup) { skipped++; continue; }
    await bankTx(ctx.orgId).insertOne({ _id: newId(), account: d.account, date, description: l.description, amount: toDecimal128(money(l.amount)), reference: l.reference ?? (null as never), status: "unmatched", importId }, undefined);
    added++;
  }
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "bank.import", resource: "bank_statement", resourceId: importId, after: { added, skipped } }));
  return { importId, added, skipped };
}

type GlLine = { _id: string; entryId: string; accountCode: string; date: Date; debit: Decimal128; credit: Decimal128 };
const WINDOW_DAYS = 5;

/** Auto-match: same signed amount against ledger lines on the bank account within a few days, each ledger line used once. */
export async function autoMatchBank(ctx: Ctx, account: "bank" | "bank_savings") {
  assertPermission(ctx, "ledger:create");
  const code = (await accountBySystem(ctx.orgId, account)).code;
  const gl = await tenantCol<GlLine>(ctx.orgId, "gl_lines").find({ accountCode: code } as never, { limit: 100000 });
  const taken = new Set((await bankTx(ctx.orgId).find({ status: "matched" } as never, { limit: 100000 })).map((t) => t.glLineId));
  const pending = await bankTx(ctx.orgId).find({ account, status: "unmatched" } as never, { sort: { date: 1 }, limit: 100000 });
  let matched = 0;
  for (const t of pending) {
    const amt = fromDecimal128(t.amount);
    const hit = gl.find((g) => !taken.has(g._id) && fromDecimal128(g.debit).minus(fromDecimal128(g.credit)).equals(amt) && Math.abs(g.date.getTime() - t.date.getTime()) <= WINDOW_DAYS * 86400000);
    if (hit) {
      await bankTx(ctx.orgId).updateOne({ _id: t._id } as never, { $set: { status: "matched", glLineId: hit._id } } as never);
      taken.add(hit._id); matched++;
    }
  }
  return { matched };
}

/** Reconciliation: statement closing balance vs ledger balance, with every unmatched item on both sides listed. */
export async function bankReconciliation(ctx: Ctx, input: { account: "bank" | "bank_savings"; statementEndBalance: string }) {
  assertPermission(ctx, "ledger:view");
  const code = (await accountBySystem(ctx.orgId, input.account)).code;
  const gl = await tenantCol<GlLine>(ctx.orgId, "gl_lines").find({ accountCode: code } as never, { limit: 100000 });
  const glBalance = gl.reduce((a, g) => a.plus(fromDecimal128(g.debit)).minus(fromDecimal128(g.credit)), money(0));
  const txs = await bankTx(ctx.orgId).find({ account: input.account } as never, { limit: 100000 });
  const matchedIds = new Set(txs.filter((t) => t.status === "matched").map((t) => t.glLineId));
  const unmatchedStatement = txs.filter((t) => t.status === "unmatched");
  const unmatchedGl = gl.filter((g) => !matchedIds.has(g._id));
  const stmt = money(input.statementEndBalance);
  const inTransit = unmatchedGl.reduce((a, g) => a.plus(fromDecimal128(g.debit)).minus(fromDecimal128(g.credit)), money(0)); // in books, not yet on statement
  const notBooked = unmatchedStatement.reduce((a, t) => a.plus(fromDecimal128(t.amount)), money(0)); // on statement, not yet in books
  const difference = stmt.minus(notBooked).minus(glBalance.minus(inTransit)); // zero when every difference is explained
  return { glBalance, statementBalance: stmt, unmatchedStatement, unmatchedGl, inTransit, notBooked, unexplainedDifference: difference, reconciled: difference.isZero() };
}

/** Payment gateway / card acquirer settlement: Dr Bank (net) + Dr charges / Cr Card clearing (gross). Idempotent per reference. */
export async function settleCardBatch(ctx: Ctx, input: { reference: string; gross: string; fees: string }) {
  assertPermission(ctx, "ledger:create");
  const d = v(z.object({ reference: z.string().min(1), gross: amount, fees: amount }).safeParse(input));
  const gross = money(d.gross), fees = money(d.fees);
  if (gross.lte(0) || fees.gt(gross)) throw new AppError("VALIDATION", "Invalid settlement amounts");
  return withTransaction(async (s) => postJournalSystem(ctx, {
    date: new Date(), memo: `Card settlement ${d.reference}`, sourceRef: { type: "card_settlement", id: d.reference }, idempotencyKey: `cardsettle:${d.reference}`,
    lines: [
      { accountId: (await accountBySystem(ctx.orgId, "bank"))._id, debit: gross.minus(fees).toFixed(2) },
      ...(fees.gt(0) ? [{ accountId: (await accountBySystem(ctx.orgId, "bank_charges"))._id, debit: fees.toFixed(2) }] : []),
      { accountId: (await accountBySystem(ctx.orgId, "card_clearing"))._id, credit: gross.toFixed(2) },
    ],
  }, s));
}

/** What the acquirer still owes: the card clearing balance. */
export async function gatewayUnsettled(ctx: Ctx): Promise<Decimal> {
  assertPermission(ctx, "ledger:view");
  const lines = await tenantCol<GlLine>(ctx.orgId, "gl_lines").find({ accountCode: "1020" } as never, { limit: 100000 });
  return lines.reduce((a, g) => a.plus(fromDecimal128(g.debit)).minus(fromDecimal128(g.credit)), money(0));
}
