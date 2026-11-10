import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { postJournalSystem, type JournalEntry, type JournalInput } from "./journal";
import { accountBySystem } from "./accounts";
import { lockPeriod, type FiscalPeriod } from "./periods";
import { dubaiParts } from "@/core/time";
import { fromDecimal128, money } from "@/core/money";

export type DraftJournal = {
  _id: string; input: Omit<JournalInput, "idempotencyKey"> & { idempotencyKey?: string }; status: "pending" | "approved" | "rejected"; createdBy: string; createdAt: Date;
  decidedBy?: string; decidedAt?: Date; journalEntryId?: string; reason?: string;
};
const drafts = (o: string) => tenantCol<DraftJournal>(o, "draft_journals");

/** Manual / adjusting journals go through approval: a different person with ledger:approve posts them. */
export async function submitJournalForApproval(ctx: Ctx, input: Omit<JournalInput, "idempotencyKey">): Promise<DraftJournal> {
  assertPermission(ctx, "ledger:create");
  const p = z.object({ memo: z.string().min(3), lines: z.array(z.object({ accountId: z.string(), debit: z.union([z.string(), z.number()]).optional(), credit: z.union([z.string(), z.number()]).optional() }).passthrough()).min(2) }).passthrough().safeParse(input);
  if (!p.success) throw new AppError("VALIDATION", p.error.message);
  const d: DraftJournal = { _id: newId(), input, status: "pending", createdBy: ctx.userId, createdAt: new Date() };
  await withTransaction(async (s) => {
    await drafts(ctx.orgId).insertOne(d, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "journal.submit", resource: "draft_journal", resourceId: d._id, after: { memo: input.memo } });
  });
  return d;
}

export async function decideDraftJournal(ctx: Ctx, id: string, approved: boolean, reason?: string): Promise<JournalEntry | null> {
  assertPermission(ctx, "ledger:approve");
  return withTransaction(async (s) => {
    const d = await drafts(ctx.orgId).findOne({ _id: id } as never, s);
    if (!d) throw new AppError("NOT_FOUND", "Draft journal not found");
    if (d.status !== "pending") throw new AppError("CONFLICT", `Journal is already ${d.status}`);
    if (d.createdBy === ctx.userId) throw new AppError("FORBIDDEN", "You cannot approve a journal you submitted");
    if (!approved) {
      if (!reason?.trim()) throw new AppError("VALIDATION", "Reason required to reject");
      await drafts(ctx.orgId).updateOne({ _id: id } as never, { $set: { status: "rejected", decidedBy: ctx.userId, decidedAt: new Date(), reason } } as never, s);
      await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "journal.reject", resource: "draft_journal", resourceId: id, after: { reason } });
      return null;
    }
    const je = await postJournalSystem(ctx, { ...d.input, date: new Date(d.input.date), idempotencyKey: `draft:${id}` }, s);
    await drafts(ctx.orgId).updateOne({ _id: id } as never, { $set: { status: "approved", decidedBy: ctx.userId, decidedAt: new Date(), journalEntryId: je._id } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "journal.approve", resource: "draft_journal", resourceId: id, after: { journalEntryId: je._id } });
    return je;
  });
}

export async function listDraftJournals(ctx: Ctx) { assertPermission(ctx, "ledger:view"); return drafts(ctx.orgId).find({} as never, { sort: { createdAt: -1 }, limit: 100 }); }

/** Period close: refuses while approvals for that period are pending, then locks it. */
export async function closePeriod(ctx: Ctx, year: number, month: number): Promise<void> {
  assertPermission(ctx, "ledger:approve");
  const p = await tenantCol<FiscalPeriod>(ctx.orgId, "fiscal_periods").findOne({ year, month } as never);
  if (!p) throw new AppError("NOT_FOUND", "Fiscal period not found");
  const pending = (await drafts(ctx.orgId).find({ status: "pending" } as never)).filter((d) => { const t = new Date(d.input.date); return t >= p.start && t < p.end; });
  if (pending.length) throw new AppError("CONFLICT", `${pending.length} journal(s) awaiting approval in this period`);
  await lockPeriod(ctx, year, month);
}

/** Year-end: moves net income into Retained Earnings with one closing entry dated 31 December, then locks all twelve periods. Idempotent. */
export async function closeFiscalYear(ctx: Ctx, year: number): Promise<JournalEntry | null> {
  assertPermission(ctx, "ledger:approve");
  const from = new Date(`${year}-01-01T00:00:00+04:00`), to = new Date(`${year + 1}-01-01T00:00:00+04:00`);
  const rows = await tenantCol<{ _id: { id: string; type: string }; debit: unknown; credit: unknown }>(ctx.orgId, "gl_lines").aggregate<{ _id: { id: string; type: string }; debit: unknown; credit: unknown }>([
    { $match: { date: { $gte: from, $lt: to }, accountType: { $in: ["income", "expense"] } } },
    { $group: { _id: { id: "$accountId", type: "$accountType" }, debit: { $sum: "$debit" }, credit: { $sum: "$credit" } } },
  ]);
  const lines: { accountId: string; debit?: string; credit?: string }[] = [];
  let net = money(0);
  for (const r of rows) {
    const bal = fromDecimal128(r._id && (r.debit as never)).minus(fromDecimal128(r.credit as never)); // debit-positive
    if (bal.isZero()) continue;
    lines.push(bal.gt(0) ? { accountId: r._id.id, credit: bal.toFixed(2) } : { accountId: r._id.id, debit: bal.abs().toFixed(2) });
    net = net.minus(bal);
  }
  let entry: JournalEntry | null = await tenantCol<JournalEntry>(ctx.orgId, "journal_entries").findOne({ idempotencyKey: `yearclose:${year}` } as never);
  if (!entry && lines.length) {
    const re = (await accountBySystem(ctx.orgId, "retained_earnings"))._id;
    lines.push(net.gte(0) ? { accountId: re, credit: net.toFixed(2) } : { accountId: re, debit: net.abs().toFixed(2) });
    entry = await withTransaction((s) => postJournalSystem(ctx, { date: new Date(`${year}-12-31T12:00:00+04:00`), memo: `Year-end close ${year}`, sourceRef: { type: "year_close", id: String(year) }, idempotencyKey: `yearclose:${year}`, lines }, s));
  }
  for (let m = 1; m <= 12; m++) {
    const p = await tenantCol<FiscalPeriod>(ctx.orgId, "fiscal_periods").findOne({ year, month: m } as never);
    if (p && p.status === "open") await lockPeriod(ctx, year, m);
  }
  void dubaiParts;
  return entry;
}
