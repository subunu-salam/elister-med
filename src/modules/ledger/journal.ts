import type { ClientSession, Decimal128 } from "mongodb";
import Decimal from "decimal.js";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { emit } from "@/core/outbox";
import { nextSeq } from "@/core/counters";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { money, sum, toDecimal128 } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import type { Account } from "./accounts";
import { assertPeriodOpen } from "./periods";

export type Dims = { branchId?: string; departmentId?: string; doctorId?: string; costCentre?: string };
export type LineInput = { accountId: string; debit?: string | number; credit?: string | number; dims?: Dims };
export type JournalInput = {
  date: Date;
  memo: string;
  lines: LineInput[];
  sourceRef: { type: string; id: string };
  idempotencyKey: string;
};

export type JournalEntry = {
  _id: string;
  entryNo: number;
  date: Date;
  memo: string;
  lines: { accountId: string; debit: Decimal128; credit: Decimal128; dims?: Dims }[];
  sourceRef: { type: string; id: string };
  idempotencyKey: string;
  status: "posted";
  reversalOf?: string;
  reversalReason?: string;
  postedBy: string;
  postedAt: Date;
  periodId: string;
};

type GlLine = {
  _id: string; entryId: string; entryNo: number; accountId: string; accountCode: string; accountType: string;
  date: Date; debit: Decimal128; credit: Decimal128; dims?: Dims;
};

const entries = (orgId: string) => tenantCol<JournalEntry>(orgId, "journal_entries");

function parseAmount(v: string | number | undefined, label: string): Decimal {
  if (v === undefined || v === "") return new Decimal(0);
  let d: Decimal;
  try { d = money(v); } catch { throw new AppError("VALIDATION", `${label} is not a number`); }
  if (!d.isFinite() || d.isNegative()) throw new AppError("VALIDATION", `${label} must be zero or positive`);
  if (d.decimalPlaces() > 2) throw new AppError("VALIDATION", `${label} has more than 2 decimal places`);
  return d;
}

async function postInTxn(ctx: Ctx, input: JournalInput, s: ClientSession, reversalOf?: string, reversalReason?: string): Promise<JournalEntry> {
  const existing = await entries(ctx.orgId).findOne({ idempotencyKey: input.idempotencyKey } as never, s);
  if (existing) return existing;

  if (input.lines.length < 2) throw new AppError("VALIDATION", "A journal needs at least two lines");
  const parsed = input.lines.map((l, i) => {
    const debit = parseAmount(l.debit, `Line ${i + 1} debit`);
    const credit = parseAmount(l.credit, `Line ${i + 1} credit`);
    if (debit.gt(0) === credit.gt(0)) throw new AppError("VALIDATION", `Line ${i + 1} must have exactly one of debit or credit`);
    return { ...l, debit, credit };
  });
  if (!sum(parsed.map((l) => l.debit)).equals(sum(parsed.map((l) => l.credit)))) {
    throw new AppError("UNBALANCED", "Total debits must equal total credits");
  }

  const period = await assertPeriodOpen(ctx.orgId, input.date, s);
  const ids = [...new Set(parsed.map((l) => l.accountId))];
  const accs = await tenantCol<Account>(ctx.orgId, "accounts").find({ _id: { $in: ids } } as never, { session: s });
  const byId = new Map(accs.map((a) => [a._id, a]));
  for (const id of ids) {
    const a = byId.get(id);
    if (!a) throw new AppError("VALIDATION", `Unknown account ${id}`);
    if (!a.active) throw new AppError("VALIDATION", `Account ${a.code} is inactive`);
  }

  const entryNo = await nextSeq(ctx.orgId, "journal", s);
  const entry: JournalEntry = {
    _id: newId(), entryNo, date: input.date, memo: input.memo, sourceRef: input.sourceRef, idempotencyKey: input.idempotencyKey,
    status: "posted", postedBy: ctx.userId, postedAt: new Date(), periodId: period._id,
    ...(reversalOf ? { reversalOf, reversalReason } : {}),
    lines: parsed.map((l) => ({ accountId: l.accountId, debit: toDecimal128(l.debit), credit: toDecimal128(l.credit), dims: l.dims })),
  };
  await entries(ctx.orgId).insertOne(entry, s);
  await tenantCol<GlLine>(ctx.orgId, "gl_lines").insertMany(
    entry.lines.map((l) => ({
      _id: newId(), entryId: entry._id, entryNo, accountId: l.accountId, accountCode: byId.get(l.accountId)!.code,
      accountType: byId.get(l.accountId)!.type, date: entry.date, debit: l.debit, credit: l.credit, dims: l.dims,
    })),
    s,
  );
  await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: reversalOf ? "journal.reverse" : "journal.post", resource: "journal_entry", resourceId: entry._id, after: { entryNo, memo: input.memo, sourceRef: input.sourceRef } });
  await emit(s, ctx.orgId, "journal.posted", { entryId: entry._id });
  return entry;
}

/** For other modules (billing, pharmacy…) that already authorised the business action. Runs in the caller's txn. */
export function postJournalSystem(ctx: Ctx, input: JournalInput, s: ClientSession): Promise<JournalEntry> {
  return postInTxn(ctx, input, s);
}

/** Manual journal (ledger:create). Idempotent on idempotencyKey. */
export async function postJournal(ctx: Ctx, input: JournalInput): Promise<JournalEntry> {
  assertPermission(ctx, "ledger:create");
  const prior = await entries(ctx.orgId).findOne({ idempotencyKey: input.idempotencyKey } as never);
  if (prior) return prior;
  try {
    return await withTransaction((s) => postInTxn(ctx, input, s));
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const won = await entries(ctx.orgId).findOne({ idempotencyKey: input.idempotencyKey } as never);
      if (won) return won;
    }
    throw e;
  }
}

/** Corrections are new entries. The original is never touched; linkage lives in journal_reversals. */
export async function reverseJournal(ctx: Ctx, entryId: string, reason: string, date: Date = new Date()): Promise<JournalEntry> {
  assertPermission(ctx, "ledger:approve");
  if (!reason.trim()) throw new AppError("VALIDATION", "Reason required");
  return withTransaction(async (s) => {
    const orig = await entries(ctx.orgId).findOne({ _id: entryId } as never, s);
    if (!orig) throw new AppError("NOT_FOUND", "Journal entry not found");
    if (orig.reversalOf) throw new AppError("CONFLICT", "A reversing entry cannot itself be reversed");
    const done = await tenantCol<{ entryId: string }>(ctx.orgId, "journal_reversals").findOne({ entryId } as never, s);
    if (done) throw new AppError("CONFLICT", "Entry already reversed");
    const rev = await postInTxn(ctx, {
      date, memo: `Reversal of #${orig.entryNo}: ${reason}`, sourceRef: { type: "reversal", id: entryId }, idempotencyKey: `reverse:${entryId}`,
      lines: orig.lines.map((l) => ({
        accountId: l.accountId, debit: l.credit.toString(), credit: l.debit.toString(), dims: l.dims,
      })).map((l) => ({ ...l, debit: l.debit === "0" ? undefined : l.debit, credit: l.credit === "0" ? undefined : l.credit })),
    }, s, entryId, reason);
    await tenantCol<{ entryId: string; reversedBy: string }>(ctx.orgId, "journal_reversals").insertOne({ entryId, reversedBy: rev._id, at: new Date(), by: ctx.userId } as never, s);
    return rev;
  });
}

export async function getJournal(ctx: Ctx, id: string): Promise<JournalEntry> {
  assertPermission(ctx, "ledger:view");
  const e = await entries(ctx.orgId).findOne({ _id: id } as never);
  if (!e) throw new AppError("NOT_FOUND", "Journal entry not found");
  return e;
}

export async function listJournals(ctx: Ctx, limit = 50) {
  assertPermission(ctx, "ledger:view");
  const rows = await entries(ctx.orgId).find({} as never, { sort: { entryNo: -1 }, limit });
  const rev = await tenantCol<{ entryId: string }>(ctx.orgId, "journal_reversals").find({ entryId: { $in: rows.map((r) => r._id) } } as never);
  const reversed = new Set(rev.map((r) => r.entryId));
  return rows.map((r) => ({ ...r, reversed: reversed.has(r._id) }));
}
