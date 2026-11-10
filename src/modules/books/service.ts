import Decimal from "decimal.js";
import type { ClientSession, Decimal128 } from "mongodb";
import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { nextSeq } from "@/core/counters";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { dubaiParts } from "@/core/time";
import { fromDecimal128, money, round2, sum, toDecimal128 } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { accountBySystem, ensureChartOfAccounts } from "@/modules/ledger/accounts";
import { postJournalSystem } from "@/modules/ledger/journal";
import { trialBalance } from "@/modules/reports/trialBalance";
import { pnl } from "@/modules/reports/pnl";
import { docNo, yearOf } from "@/modules/billing/invoice";

/**
 * Business books: the non-patient side of the ledger. Corporate customers (occupational-health contracts, vendors renting space, group
 * clients) get estimates, sales orders, delivery challans, invoices, receipts, credit notes and recurring invoices; suppliers get vendor
 * credits; the bank gets deposits, withdrawals and transfers. Every posting goes through the same journal as the clinical modules, so
 * the trial balance, P&L, balance sheet, VAT return and corporate tax all include it automatically.
 */
export type VatRate = "STD" | "ZERO" | "EXEMPT";
export type Line = { description: string; qty: number; unitPrice: string; vatRate: VatRate; accountCode: string };
export type Customer = { _id: string; name: string; trn?: string; email?: string; phone?: string; termsDays: number; active: boolean; createdAt: Date };
export type DocKind = "estimate" | "sales_order" | "delivery_challan";
export type SalesDoc = {
  _id: string; kind: DocKind; number: string; customerId: string; date: Date; lines: Line[]; net: Decimal128; vat: Decimal128; total: Decimal128; notes?: string;
  status: "draft" | "sent" | "accepted" | "declined" | "converted" | "delivered"; convertedTo?: { kind: string; id: string }; by: string; createdAt: Date;
};
export type TradeInvoice = {
  _id: string; number: string; customerId: string; issueDate: Date; dueDate: Date; lines: Line[]; net: Decimal128; vat: Decimal128; total: Decimal128; paid: Decimal128; balance: Decimal128; notes?: string;
  status: "draft" | "open" | "partially_paid" | "paid" | "void"; journalEntryId?: string; sourceDoc?: { kind: string; id: string }; recurringId?: string; idempotencyKey?: string; by: string; createdAt: Date;
};
export type Receipt = { _id: string; number: string; customerId: string; invoiceId?: string; amount: Decimal128; unapplied: Decimal128; method: "bank" | "cash" | "card_clearing"; reference?: string; date: Date; journalEntryId: string; idempotencyKey: string; by: string; at: Date };
export type TradeCreditNote = {
  _id: string; number: string; customerId: string; invoiceId?: string; lines: Line[]; net: Decimal128; vat: Decimal128; total: Decimal128; unapplied: Decimal128; reason: string; date: Date;
  journalEntryId: string; idempotencyKey: string; by: string; at: Date;
};
export type Recurring = {
  _id: string; name: string; customerId: string; frequency: "weekly" | "monthly" | "quarterly" | "yearly"; nextDate: Date; lines: Line[]; status: "active" | "paused" | "stopped"; termsDays: number;
  generated: number; lastInvoiceId?: string; by: string; createdAt: Date;
};
export type VendorCredit = {
  _id: string; number: string; supplierId: string; supplierInvoiceId?: string; lines: Line[]; net: Decimal128; vat: Decimal128; total: Decimal128; unapplied: Decimal128; reason: string; date: Date;
  journalEntryId: string; idempotencyKey: string; by: string; at: Date;
};

const customers = (o: string) => tenantCol<Customer>(o, "customers");
const sdocs = (o: string) => tenantCol<SalesDoc>(o, "sales_docs");
const tinv = (o: string) => tenantCol<TradeInvoice>(o, "trade_invoices");
const rcts = (o: string) => tenantCol<Receipt>(o, "trade_receipts");
const tcn = (o: string) => tenantCol<TradeCreditNote>(o, "trade_credit_notes");
const recs = (o: string) => tenantCol<Recurring>(o, "recurring_invoices");
const vcs = (o: string) => tenantCol<VendorCredit>(o, "vendor_credits");
const sinv = (o: string) => tenantCol<{ _id: string; supplierId: string; status: string; paid: Decimal128; balance: Decimal128 }>(o, "supplier_invoices");

const v = <T>(r: { success: true; data: T } | { success: false; error: { message: string } }): T => { if (!r.success) throw new AppError("VALIDATION", r.error.message); return r.data; };
const amt = z.string().regex(/^\d+(\.\d{1,2})?$/, "Amount must be a positive number with at most 2 decimals");
const day = (d: Date) => dubaiParts(d).ymd;
const startOfDay = (d: Date) => new Date(`${day(d)}T00:00:00+04:00`);
const VAT_PCT = 5;

const ready = new Set<string>();
/** Accounts added after the first release are created before any transaction opens (a transaction cannot see rows created mid-flight), so existing databases need no migration. */
async function readyOrg(orgId: string) {
  if (ready.has(orgId)) return;
  await ensureChartOfAccounts(orgId);
  ready.add(orgId);
}
const sys = (orgId: string, system: string) => accountBySystem(orgId, system);

/**
 * "Description | qty | unit price | STD|ZERO|EXEMPT | account code" per line. Qty defaults to 1, VAT to STD, account to the default for the document.
 * Free text keeps the form usable without client-side JavaScript.
 */
export function parseLines(text: string, defaultAccount: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split("\n").map((x) => x.trim()).filter(Boolean)) {
    const [description, q, p, vr, ac] = raw.split("|").map((x) => x.trim());
    const qty = q ? Number(q) : 1;
    const unitPrice = (p ?? "").replace(/,/g, "");
    if (!description) throw new AppError("VALIDATION", `Line "${raw}" has no description`);
    if (!Number.isFinite(qty) || qty <= 0) throw new AppError("VALIDATION", `Line "${description}": quantity must be above zero`);
    if (!/^\d+(\.\d{1,2})?$/.test(unitPrice)) throw new AppError("VALIDATION", `Line "${description}": unit price must be a number with at most 2 decimals (format: Description | qty | price | STD)`);
    const vatRate = (vr || "STD").toUpperCase();
    if (!["STD", "ZERO", "EXEMPT"].includes(vatRate)) throw new AppError("VALIDATION", `Line "${description}": VAT must be STD, ZERO or EXEMPT`);
    out.push({ description, qty, unitPrice, vatRate: vatRate as VatRate, accountCode: ac || defaultAccount });
  }
  if (!out.length) throw new AppError("VALIDATION", "Add at least one line");
  return out;
}

export function totalsOf(lines: Line[]) {
  const rows = lines.map((l) => {
    const net = round2(money(l.unitPrice).times(l.qty));
    return { ...l, net, vat: l.vatRate === "STD" ? round2(net.times(VAT_PCT).div(100)) : money(0) };
  });
  const net = sum(rows.map((r) => r.net)), vat = sum(rows.map((r) => r.vat));
  return { rows, net, vat, total: net.plus(vat) };
}
const byAccount = (rows: { accountCode: string; net: Decimal }[]) => {
  const m = new Map<string, Decimal>();
  for (const r of rows) m.set(r.accountCode, (m.get(r.accountCode) ?? money(0)).plus(r.net));
  return m;
};

async function checkAccounts(ctx: Ctx, codes: string[], type: "income" | "expense") {
  const found = await tenantCol<{ code: string; type: string; active: boolean }>(ctx.orgId, "accounts").find({ code: { $in: [...new Set(codes)] } } as never);
  for (const c of new Set(codes)) {
    const a = found.find((x) => x.code === c);
    if (!a || a.type !== type || !a.active) throw new AppError("VALIDATION", `Account ${c} is not an active ${type} account`);
  }
}

// ---------------------------------------------------------------- customers
export async function createCustomer(ctx: Ctx, input: { name: string; trn?: string; email?: string; phone?: string; termsDays?: number }): Promise<Customer> {
  assertPermission(ctx, "ledger:create");
  const d = v(z.object({ name: z.string().min(2), trn: z.string().regex(/^\d{15}$/, "TRN is 15 digits").optional().or(z.literal("")), email: z.string().email().optional().or(z.literal("")), phone: z.string().optional(), termsDays: z.number().int().min(0).max(365).default(30) }).safeParse(input));
  const c: Customer = { _id: newId(), name: d.name, trn: d.trn || undefined, email: d.email || undefined, phone: d.phone || undefined, termsDays: d.termsDays, active: true, createdAt: new Date() };
  await withTransaction(async (s) => {
    await customers(ctx.orgId).insertOne(c, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "customer.create", resource: "customer", resourceId: c._id, after: { name: c.name } });
  });
  return c;
}
async function needCustomer(ctx: Ctx, id: string, s?: ClientSession) {
  const c = await customers(ctx.orgId).findOne({ _id: id } as never, s);
  if (!c) throw new AppError("NOT_FOUND", "Customer not found");
  return c;
}

// ---------------------------------------------------------------- estimates, sales orders, delivery challans
const PREFIX: Record<DocKind, string> = { estimate: "EST", sales_order: "SO", delivery_challan: "DC" };
export async function createSalesDoc(ctx: Ctx, input: { kind: DocKind; customerId: string; date?: Date; lines: Line[]; notes?: string }): Promise<SalesDoc> {
  assertPermission(ctx, "ledger:create");
  await readyOrg(ctx.orgId);
  await needCustomer(ctx, input.customerId);
  await checkAccounts(ctx, input.lines.map((l) => l.accountCode), "income");
  const t = totalsOf(input.lines);
  return withTransaction(async (s) => {
    const year = yearOf();
    const doc: SalesDoc = {
      _id: newId(), kind: input.kind, number: docNo(PREFIX[input.kind], year, await nextSeq(ctx.orgId, `${PREFIX[input.kind]}:${year}`, s)), customerId: input.customerId, date: input.date ?? new Date(),
      lines: input.lines, net: toDecimal128(t.net), vat: toDecimal128(t.vat), total: toDecimal128(t.total), notes: input.notes, status: "draft", by: ctx.userId, createdAt: new Date(),
    };
    await sdocs(ctx.orgId).insertOne(doc, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: `${input.kind}.create`, resource: "sales_doc", resourceId: doc._id, after: { number: doc.number, total: t.total.toFixed(2) } });
    return doc;
  });
}
export async function setSalesDocStatus(ctx: Ctx, id: string, status: SalesDoc["status"]): Promise<void> {
  assertPermission(ctx, "ledger:create");
  const d = await sdocs(ctx.orgId).findOne({ _id: id } as never);
  if (!d) throw new AppError("NOT_FOUND", "Document not found");
  if (d.status === "converted") throw new AppError("CONFLICT", "Already converted");
  const allowed: Record<DocKind, SalesDoc["status"][]> = { estimate: ["sent", "accepted", "declined"], sales_order: ["sent", "accepted", "declined"], delivery_challan: ["sent", "delivered"] };
  if (!allowed[d.kind].includes(status)) throw new AppError("VALIDATION", `A ${d.kind.replace("_", " ")} cannot be marked ${status}`);
  await sdocs(ctx.orgId).updateOne({ _id: id } as never, { $set: { status } } as never);
}
/** estimate -> sales order or invoice; sales order -> delivery challan or invoice; challan -> invoice. Invoices are created as drafts for review. */
export async function convertSalesDoc(ctx: Ctx, id: string, to: "sales_order" | "delivery_challan" | "invoice"): Promise<{ kind: string; id: string }> {
  assertPermission(ctx, "ledger:create");
  const d = await sdocs(ctx.orgId).findOne({ _id: id } as never);
  if (!d) throw new AppError("NOT_FOUND", "Document not found");
  if (d.status === "converted") throw new AppError("CONFLICT", "Already converted");
  if (d.status === "declined") throw new AppError("CONFLICT", "A declined document cannot be converted");
  const ok: Record<DocKind, string[]> = { estimate: ["sales_order", "invoice"], sales_order: ["delivery_challan", "invoice"], delivery_challan: ["invoice"] };
  if (!ok[d.kind].includes(to)) throw new AppError("VALIDATION", `A ${d.kind.replace("_", " ")} cannot become a ${to.replace("_", " ")}`);
  const target = to === "invoice"
    ? await createInvoice(ctx, { customerId: d.customerId, lines: d.lines, notes: `From ${d.number}`, sourceDoc: { kind: d.kind, id: d._id }, issue: false, idempotencyKey: `conv:${d._id}` })
    : await createSalesDoc(ctx, { kind: to, customerId: d.customerId, lines: d.lines, notes: `From ${d.number}` });
  const ref = { kind: to, id: target._id };
  await sdocs(ctx.orgId).updateOne({ _id: id } as never, { $set: { status: "converted", convertedTo: ref } } as never);
  return ref;
}

// ---------------------------------------------------------------- invoices
async function postInvoiceJournal(ctx: Ctx, inv: TradeInvoice, s: ClientSession) {
  const t = totalsOf(inv.lines);
  const rev = byAccount(t.rows);
  const lines = [
    { accountId: (await sys(ctx.orgId, "ar_trade"))._id, debit: t.total.toFixed(2) },
    ...[...rev].filter(([, n]) => n.gt(0)).map(([code, n]) => ({ accountId: `${ctx.orgId}:${code}`, credit: n.toFixed(2) })),
    ...(t.vat.gt(0) ? [{ accountId: (await accountBySystem(ctx.orgId, "vat_output"))._id, credit: t.vat.toFixed(2) }] : []),
  ];
  return postJournalSystem(ctx, { date: inv.issueDate, memo: `Invoice ${inv.number}`, sourceRef: { type: "trade_invoice", id: inv._id }, idempotencyKey: `tinv:${inv._id}`, lines }, s);
}

export async function createInvoice(ctx: Ctx, input: { customerId: string; issueDate?: Date; dueDate?: Date; lines: Line[]; notes?: string; issue?: boolean; sourceDoc?: { kind: string; id: string }; recurringId?: string; idempotencyKey?: string }): Promise<TradeInvoice> {
  assertPermission(ctx, "ledger:create");
  await readyOrg(ctx.orgId);
  if (input.idempotencyKey) { const prior = await tinv(ctx.orgId).findOne({ idempotencyKey: input.idempotencyKey } as never); if (prior) return prior; }
  const cust = await needCustomer(ctx, input.customerId);
  await checkAccounts(ctx, input.lines.map((l) => l.accountCode), "income");
  const t = totalsOf(input.lines);
  if (t.total.lte(0)) throw new AppError("VALIDATION", "Invoice total must be above zero");
  const issueDate = input.issueDate ?? new Date();
  return withTransaction(async (s) => {
    const year = yearOf(issueDate);
    const inv: TradeInvoice = {
      _id: newId(), number: docNo("BINV", year, await nextSeq(ctx.orgId, `BINV:${year}`, s)), customerId: cust._id, issueDate, dueDate: input.dueDate ?? new Date(issueDate.getTime() + cust.termsDays * 86400000),
      lines: input.lines, net: toDecimal128(t.net), vat: toDecimal128(t.vat), total: toDecimal128(t.total), paid: toDecimal128(money(0)), balance: toDecimal128(t.total), notes: input.notes,
      status: "draft", sourceDoc: input.sourceDoc, recurringId: input.recurringId, idempotencyKey: input.idempotencyKey, by: ctx.userId, createdAt: new Date(),
    };
    if (input.issue) { inv.status = "open"; inv.journalEntryId = (await postInvoiceJournal(ctx, inv, s))._id; }
    await tinv(ctx.orgId).insertOne(inv, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: input.issue ? "trade_invoice.issue" : "trade_invoice.draft", resource: "trade_invoice", resourceId: inv._id, after: { number: inv.number, total: t.total.toFixed(2) } });
    return inv;
  });
}
export async function issueInvoice(ctx: Ctx, id: string): Promise<TradeInvoice> {
  assertPermission(ctx, "ledger:create");
  await readyOrg(ctx.orgId);
  return withTransaction(async (s) => {
    const inv = await tinv(ctx.orgId).findOne({ _id: id } as never, s);
    if (!inv) throw new AppError("NOT_FOUND", "Invoice not found");
    if (inv.status !== "draft") throw new AppError("CONFLICT", `Invoice is ${inv.status}`);
    const je = await postInvoiceJournal(ctx, inv, s);
    await tinv(ctx.orgId).updateOne({ _id: id, status: "draft" } as never, { $set: { status: "open", journalEntryId: je._id } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "trade_invoice.issue", resource: "trade_invoice", resourceId: id, after: { number: inv.number } });
    return { ...inv, status: "open", journalEntryId: je._id };
  });
}
/** Reverses the posting with an opposite entry. Only unpaid, issued invoices can be voided; a paid one needs a credit note. */
export async function voidInvoice(ctx: Ctx, id: string, reason: string): Promise<void> {
  assertPermission(ctx, "ledger:approve");
  await readyOrg(ctx.orgId);
  if (!reason.trim()) throw new AppError("VALIDATION", "Reason required");
  await withTransaction(async (s) => {
    const inv = await tinv(ctx.orgId).findOne({ _id: id } as never, s);
    if (!inv) throw new AppError("NOT_FOUND", "Invoice not found");
    if (inv.status === "draft") { await tinv(ctx.orgId).updateOne({ _id: id } as never, { $set: { status: "void" } } as never, s); return; }
    if (inv.status !== "open" || !fromDecimal128(inv.paid).isZero()) throw new AppError("CONFLICT", "Only an unpaid issued invoice can be voided. Use a credit note for the rest.");
    const t = totalsOf(inv.lines), rev = byAccount(t.rows);
    await postJournalSystem(ctx, {
      date: new Date(), memo: `Void ${inv.number}: ${reason}`, sourceRef: { type: "trade_invoice_void", id }, idempotencyKey: `tinv-void:${id}`,
      lines: [
        { accountId: (await sys(ctx.orgId, "ar_trade"))._id, credit: t.total.toFixed(2) },
        ...[...rev].filter(([, n]) => n.gt(0)).map(([code, n]) => ({ accountId: `${ctx.orgId}:${code}`, debit: n.toFixed(2) })),
        ...(t.vat.gt(0) ? [{ accountId: (await accountBySystem(ctx.orgId, "vat_output"))._id, debit: t.vat.toFixed(2) }] : []),
      ],
    }, s);
    await tinv(ctx.orgId).updateOne({ _id: id, status: "open" } as never, { $set: { status: "void", balance: toDecimal128(money(0)) } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "trade_invoice.void", resource: "trade_invoice", resourceId: id, after: { reason } });
  });
}

async function applyToInvoice(ctx: Ctx, invoiceId: string, customerId: string, want: Decimal, s: ClientSession): Promise<Decimal> {
  const inv = await tinv(ctx.orgId).findOne({ _id: invoiceId } as never, s);
  if (!inv || inv.customerId !== customerId) throw new AppError("NOT_FOUND", "Invoice not found for this customer");
  if (!["open", "partially_paid"].includes(inv.status)) throw new AppError("CONFLICT", `Invoice is ${inv.status}`);
  const bal = fromDecimal128(inv.balance);
  const use = Decimal.min(want, bal);
  const nb = bal.minus(use);
  const up = await tinv(ctx.orgId).updateOne({ _id: inv._id, balance: inv.balance } as never, { $set: { balance: toDecimal128(nb), paid: toDecimal128(fromDecimal128(inv.paid).plus(use)), status: nb.isZero() ? "paid" : "partially_paid" } } as never, s);
  if (up.matchedCount === 0) throw new AppError("CONFLICT", "Invoice changed concurrently");
  return use;
}

// ---------------------------------------------------------------- receipts (money in)
export async function recordReceipt(ctx: Ctx, input: { customerId: string; invoiceId?: string; amount: string; method: Receipt["method"]; reference?: string; date?: Date; idempotencyKey: string }): Promise<Receipt> {
  assertPermission(ctx, "ledger:create");
  await readyOrg(ctx.orgId);
  const d = v(z.object({ customerId: z.string(), invoiceId: z.string().optional(), amount: amt, method: z.enum(["bank", "cash", "card_clearing"]), idempotencyKey: z.string().min(1) }).safeParse(input));
  const amount = money(d.amount);
  if (amount.lte(0)) throw new AppError("VALIDATION", "Amount must be above zero");
  const prior = await rcts(ctx.orgId).findOne({ idempotencyKey: d.idempotencyKey } as never);
  if (prior) return prior;
  await needCustomer(ctx, d.customerId);
  try {
    return await withTransaction(async (s) => {
      const id = newId();
      const applied = d.invoiceId ? await applyToInvoice(ctx, d.invoiceId, d.customerId, amount, s) : money(0);
      if (d.invoiceId && amount.gt(applied)) throw new AppError("VALIDATION", "Receipt exceeds the invoice balance. Leave the invoice blank to keep the rest on account.");
      const date = input.date ?? new Date();
      const je = await postJournalSystem(ctx, {
        date, memo: `Receipt from customer${input.reference ? ` (${input.reference})` : ""}`, sourceRef: { type: "trade_receipt", id }, idempotencyKey: `rct:${d.idempotencyKey}`,
        lines: [{ accountId: (await accountBySystem(ctx.orgId, d.method))._id, debit: amount.toFixed(2) }, { accountId: (await sys(ctx.orgId, "ar_trade"))._id, credit: amount.toFixed(2) }],
      }, s);
      const year = yearOf(date);
      const r: Receipt = { _id: id, number: docNo("RCT", year, await nextSeq(ctx.orgId, `RCT:${year}`, s)), customerId: d.customerId, invoiceId: d.invoiceId, amount: toDecimal128(amount), unapplied: toDecimal128(amount.minus(applied)), method: d.method, reference: input.reference, date, journalEntryId: je._id, idempotencyKey: d.idempotencyKey, by: ctx.userId, at: new Date() };
      await rcts(ctx.orgId).insertOne(r, s);
      await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "trade_receipt.record", resource: "trade_receipt", resourceId: id, after: { amount: amount.toFixed(2), invoiceId: d.invoiceId } });
      return r;
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) { const won = await rcts(ctx.orgId).findOne({ idempotencyKey: d.idempotencyKey } as never); if (won) return won; }
    throw e;
  }
}

/** Puts an on-account receipt or credit note against an open invoice. No journal: the customer's receivable already carries the credit. */
export async function applyCredit(ctx: Ctx, input: { source: "receipt" | "credit_note"; sourceId: string; invoiceId: string }): Promise<Decimal> {
  assertPermission(ctx, "ledger:create");
  return withTransaction(async (s) => {
    const col = (input.source === "receipt" ? rcts(ctx.orgId) : tcn(ctx.orgId)) as unknown as { findOne: (f: object, s?: ClientSession) => Promise<{ customerId: string; unapplied: Decimal128 } | null>; updateOne: (f: object, u: object, s?: ClientSession) => Promise<unknown> };
    const src = await col.findOne({ _id: input.sourceId }, s);
    if (!src) throw new AppError("NOT_FOUND", "Source document not found");
    const left = fromDecimal128(src.unapplied);
    if (left.lte(0)) throw new AppError("CONFLICT", "Nothing left to apply");
    const used = await applyToInvoice(ctx, input.invoiceId, src.customerId, left, s);
    await col.updateOne({ _id: input.sourceId }, { $set: { unapplied: toDecimal128(left.minus(used)) } }, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "trade_credit.apply", resource: input.source, resourceId: input.sourceId, after: { invoiceId: input.invoiceId, amount: used.toFixed(2) } });
    return used;
  });
}

// ---------------------------------------------------------------- credit notes (sales returns, price adjustments)
export async function issueTradeCreditNote(ctx: Ctx, input: { customerId: string; invoiceId?: string; lines: Line[]; reason: string; idempotencyKey: string }): Promise<TradeCreditNote> {
  assertPermission(ctx, "ledger:create");
  await readyOrg(ctx.orgId);
  if (input.reason.trim().length < 3) throw new AppError("VALIDATION", "Give a reason");
  const prior = await tcn(ctx.orgId).findOne({ idempotencyKey: input.idempotencyKey } as never);
  if (prior) return prior;
  await needCustomer(ctx, input.customerId);
  await checkAccounts(ctx, input.lines.map((l) => l.accountCode), "income");
  const t = totalsOf(input.lines);
  if (t.total.lte(0)) throw new AppError("VALIDATION", "Credit note total must be above zero");
  try {
    return await withTransaction(async (s) => {
      const id = newId(), rev = byAccount(t.rows);
      if (input.invoiceId) {
        const inv = await tinv(ctx.orgId).findOne({ _id: input.invoiceId } as never, s);
        if (!inv || inv.customerId !== input.customerId) throw new AppError("NOT_FOUND", "Invoice not found for this customer");
        if (inv.status === "draft" || inv.status === "void") throw new AppError("CONFLICT", `Invoice is ${inv.status}`);
        if (t.total.gt(fromDecimal128(inv.total))) throw new AppError("VALIDATION", "Credit note is larger than the invoice");
      }
      const date = new Date();
      const je = await postJournalSystem(ctx, {
        date, memo: `Credit note: ${input.reason}`, sourceRef: { type: "trade_credit_note", id }, idempotencyKey: `tcn:${input.idempotencyKey}`,
        lines: [
          ...[...rev].filter(([, n]) => n.gt(0)).map(([code, n]) => ({ accountId: `${ctx.orgId}:${code}`, debit: n.toFixed(2) })),
          ...(t.vat.gt(0) ? [{ accountId: (await accountBySystem(ctx.orgId, "vat_output"))._id, debit: t.vat.toFixed(2) }] : []),
          { accountId: (await sys(ctx.orgId, "ar_trade"))._id, credit: t.total.toFixed(2) },
        ],
      }, s);
      let applied = money(0);
      if (input.invoiceId) {
        const inv = await tinv(ctx.orgId).findOne({ _id: input.invoiceId } as never, s);
        if (inv && ["open", "partially_paid"].includes(inv.status)) applied = await applyToInvoice(ctx, input.invoiceId, input.customerId, t.total, s);
      }
      const year = yearOf(date);
      const cn: TradeCreditNote = { _id: id, number: docNo("TCN", year, await nextSeq(ctx.orgId, `TCN:${year}`, s)), customerId: input.customerId, invoiceId: input.invoiceId, lines: input.lines, net: toDecimal128(t.net), vat: toDecimal128(t.vat), total: toDecimal128(t.total), unapplied: toDecimal128(t.total.minus(applied)), reason: input.reason, date, journalEntryId: je._id, idempotencyKey: input.idempotencyKey, by: ctx.userId, at: new Date() };
      await tcn(ctx.orgId).insertOne(cn, s);
      await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "trade_credit_note.issue", resource: "trade_credit_note", resourceId: id, after: { number: cn.number, total: t.total.toFixed(2) } });
      return cn;
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) { const won = await tcn(ctx.orgId).findOne({ idempotencyKey: input.idempotencyKey } as never); if (won) return won; }
    throw e;
  }
}

// ---------------------------------------------------------------- recurring invoices
const addFreq = (d: Date, f: Recurring["frequency"]) => {
  const x = new Date(d.getTime());
  if (f === "weekly") x.setUTCDate(x.getUTCDate() + 7);
  else if (f === "monthly") x.setUTCMonth(x.getUTCMonth() + 1);
  else if (f === "quarterly") x.setUTCMonth(x.getUTCMonth() + 3);
  else x.setUTCFullYear(x.getUTCFullYear() + 1);
  return x;
};
export async function createRecurring(ctx: Ctx, input: { name: string; customerId: string; frequency: Recurring["frequency"]; startDate: Date; lines: Line[] }): Promise<Recurring> {
  assertPermission(ctx, "ledger:create");
  await readyOrg(ctx.orgId);
  if (input.name.trim().length < 2) throw new AppError("VALIDATION", "Name the profile");
  const cust = await needCustomer(ctx, input.customerId);
  await checkAccounts(ctx, input.lines.map((l) => l.accountCode), "income");
  const r: Recurring = { _id: newId(), name: input.name, customerId: cust._id, frequency: input.frequency, nextDate: startOfDay(input.startDate), lines: input.lines, status: "active", termsDays: cust.termsDays, generated: 0, by: ctx.userId, createdAt: new Date() };
  await withTransaction(async (s) => {
    await recs(ctx.orgId).insertOne(r, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "recurring_invoice.create", resource: "recurring_invoice", resourceId: r._id, after: { name: r.name, frequency: r.frequency } });
  });
  return r;
}
export async function setRecurringStatus(ctx: Ctx, id: string, status: Recurring["status"]): Promise<void> {
  assertPermission(ctx, "ledger:create");
  const res = await recs(ctx.orgId).updateOne({ _id: id } as never, { $set: { status } } as never);
  if (res.matchedCount === 0) throw new AppError("NOT_FOUND", "Profile not found");
}
/** Issues the invoice for the profile's current due date, then moves the date forward. Idempotent per (profile, due date). */
export async function generateRecurring(ctx: Ctx, id: string): Promise<TradeInvoice> {
  assertPermission(ctx, "ledger:create");
  const r = await recs(ctx.orgId).findOne({ _id: id } as never);
  if (!r) throw new AppError("NOT_FOUND", "Profile not found");
  if (r.status !== "active") throw new AppError("CONFLICT", `Profile is ${r.status}`);
  const inv = await createInvoice(ctx, { customerId: r.customerId, issueDate: new Date(), lines: r.lines, notes: `Recurring: ${r.name}`, issue: true, recurringId: r._id, idempotencyKey: `rec:${r._id}:${day(r.nextDate)}` });
  await recs(ctx.orgId).updateOne({ _id: id, nextDate: r.nextDate } as never, { $set: { nextDate: addFreq(r.nextDate, r.frequency), lastInvoiceId: inv._id }, $inc: { generated: 1 } } as never);
  return inv;
}
export async function runDueRecurring(ctx: Ctx, now = new Date()): Promise<number> {
  assertPermission(ctx, "ledger:create");
  const due = await recs(ctx.orgId).find({ status: "active", nextDate: { $lte: now } } as never, { limit: 500 });
  let n = 0;
  for (const r of due) {
    let guard = 0;
    for (let cur: typeof r | null = r; cur && cur.nextDate <= now && guard < 24; guard++) { await generateRecurring(ctx, cur._id); n++; cur = await recs(ctx.orgId).findOne({ _id: cur._id } as never); }
  }
  return n;
}

// ---------------------------------------------------------------- vendor credits (supplier credit notes)
export async function recordVendorCredit(ctx: Ctx, input: { supplierId: string; supplierInvoiceId?: string; lines: Line[]; reason: string; idempotencyKey: string }): Promise<VendorCredit> {
  assertPermission(ctx, "ledger:create");
  if (input.reason.trim().length < 3) throw new AppError("VALIDATION", "Give a reason");
  const prior = await vcs(ctx.orgId).findOne({ idempotencyKey: input.idempotencyKey } as never);
  if (prior) return prior;
  if (!(await tenantCol(ctx.orgId, "suppliers").findOne({ _id: input.supplierId } as never))) throw new AppError("NOT_FOUND", "Supplier not found");
  await checkAccounts(ctx, input.lines.map((l) => l.accountCode), "expense");
  const t = totalsOf(input.lines);
  if (t.total.lte(0)) throw new AppError("VALIDATION", "Credit total must be above zero");
  try {
    return await withTransaction(async (s) => {
      const id = newId(), exp = byAccount(t.rows);
      const date = new Date();
      const je = await postJournalSystem(ctx, {
        date, memo: `Vendor credit: ${input.reason}`, sourceRef: { type: "vendor_credit", id }, idempotencyKey: `vc:${input.idempotencyKey}`,
        lines: [
          { accountId: (await accountBySystem(ctx.orgId, "ap"))._id, debit: t.total.toFixed(2) },
          ...[...exp].filter(([, n]) => n.gt(0)).map(([code, n]) => ({ accountId: `${ctx.orgId}:${code}`, credit: n.toFixed(2) })),
          ...(t.vat.gt(0) ? [{ accountId: (await accountBySystem(ctx.orgId, "vat_input"))._id, credit: t.vat.toFixed(2) }] : []),
        ],
      }, s);
      let applied = money(0);
      if (input.supplierInvoiceId) {
        const si = await sinv(ctx.orgId).findOne({ _id: input.supplierInvoiceId } as never, s);
        if (!si || si.supplierId !== input.supplierId) throw new AppError("NOT_FOUND", "Supplier invoice not found for this supplier");
        if (["approved", "partially_paid"].includes(si.status)) {
          const bal = fromDecimal128(si.balance);
          applied = Decimal.min(bal, t.total);
          const nb = bal.minus(applied);
          await sinv(ctx.orgId).updateOne({ _id: si._id, balance: si.balance } as never, { $set: { balance: toDecimal128(nb), paid: toDecimal128(fromDecimal128(si.paid).plus(applied)), status: nb.isZero() ? "paid" : "partially_paid" } } as never, s);
        }
      }
      const year = yearOf(date);
      const vc: VendorCredit = { _id: id, number: docNo("VC", year, await nextSeq(ctx.orgId, `VC:${year}`, s)), supplierId: input.supplierId, supplierInvoiceId: input.supplierInvoiceId, lines: input.lines, net: toDecimal128(t.net), vat: toDecimal128(t.vat), total: toDecimal128(t.total), unapplied: toDecimal128(t.total.minus(applied)), reason: input.reason, date, journalEntryId: je._id, idempotencyKey: input.idempotencyKey, by: ctx.userId, at: new Date() };
      await vcs(ctx.orgId).insertOne(vc, s);
      await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "vendor_credit.record", resource: "vendor_credit", resourceId: id, after: { number: vc.number, total: t.total.toFixed(2) } });
      return vc;
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) { const won = await vcs(ctx.orgId).findOne({ idempotencyKey: input.idempotencyKey } as never); if (won) return won; }
    throw e;
  }
}

// ---------------------------------------------------------------- banking
export const BANK_SYSTEMS = ["bank", "bank_savings", "cash", "petty_cash"] as const;
/** Money in or out that has no document behind it (interest, owner capital, bank charges, loan drawdown) and transfers between cash and bank accounts. */
export async function bankTransaction(ctx: Ctx, input: { type: "deposit" | "withdrawal" | "transfer"; account: (typeof BANK_SYSTEMS)[number]; otherCode: string; amount: string; date?: Date; description: string; idempotencyKey: string }): Promise<void> {
  assertPermission(ctx, "ledger:create");
  const d = v(z.object({ amount: amt, description: z.string().min(3), idempotencyKey: z.string().min(1) }).safeParse(input));
  const a = money(d.amount);
  if (a.lte(0)) throw new AppError("VALIDATION", "Amount must be above zero");
  const mine = (await accountBySystem(ctx.orgId, input.account))._id;
  const other = input.type === "transfer" ? (await accountBySystem(ctx.orgId, input.otherCode))._id : `${ctx.orgId}:${input.otherCode}`;
  if (other === mine) throw new AppError("VALIDATION", "Choose two different accounts");
  const acc = await tenantCol<{ _id: string; active: boolean }>(ctx.orgId, "accounts").findOne({ _id: other } as never);
  if (!acc || !acc.active) throw new AppError("VALIDATION", "Counter account not found or inactive");
  const lines = input.type === "withdrawal"
    ? [{ accountId: other, debit: a.toFixed(2) }, { accountId: mine, credit: a.toFixed(2) }]
    : [{ accountId: mine, debit: a.toFixed(2) }, { accountId: other, credit: a.toFixed(2) }];
  // transfer: "account" is the destination, "otherCode" the source system key
  await withTransaction(async (s) => {
    await postJournalSystem(ctx, { date: input.date ?? new Date(), memo: `Bank ${input.type}: ${d.description}`, sourceRef: { type: "bank_transaction", id: d.idempotencyKey }, idempotencyKey: `banktx:${d.idempotencyKey}`, lines }, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: `bank.${input.type}`, resource: "bank_transaction", resourceId: d.idempotencyKey, after: { amount: a.toFixed(2), description: d.description } });
  });
}

/** Locks every open fiscal period up to and including the given month (the "transaction lock date"). */
export async function lockThrough(ctx: Ctx, year: number, month: number): Promise<number> {
  assertPermission(ctx, "ledger:approve");
  const res = await tenantCol(ctx.orgId, "fiscal_periods").updateMany({ status: "open", $or: [{ year: { $lt: year } }, { year, month: { $lte: month } }] } as never, { $set: { status: "locked" } } as never);
  await withTransaction(async (s) => { await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "period.lock_through", resource: "fiscal_period", resourceId: `${year}-${month}`, after: { locked: res.modifiedCount } }); });
  return res.modifiedCount;
}

// ---------------------------------------------------------------- reads
const lim = { sort: { createdAt: -1 }, limit: 200 } as const;
export async function listCustomers(ctx: Ctx) { assertPermission(ctx, "ledger:view"); return customers(ctx.orgId).find({} as never, { sort: { name: 1 }, limit: 500 }); }
export async function listSalesDocs(ctx: Ctx, kind: DocKind) { assertPermission(ctx, "ledger:view"); return sdocs(ctx.orgId).find({ kind } as never, lim); }
export async function listTradeInvoices(ctx: Ctx) { assertPermission(ctx, "ledger:view"); return tinv(ctx.orgId).find({} as never, lim); }
export async function listReceipts(ctx: Ctx) { assertPermission(ctx, "ledger:view"); return rcts(ctx.orgId).find({} as never, { sort: { at: -1 }, limit: 200 }); }
export async function listTradeCreditNotes(ctx: Ctx) { assertPermission(ctx, "ledger:view"); return tcn(ctx.orgId).find({} as never, { sort: { at: -1 }, limit: 200 }); }
export async function listRecurring(ctx: Ctx) { assertPermission(ctx, "ledger:view"); return recs(ctx.orgId).find({} as never, lim); }
export async function listVendorCredits(ctx: Ctx) { assertPermission(ctx, "ledger:view"); return vcs(ctx.orgId).find({} as never, { sort: { at: -1 }, limit: 200 }); }

/** Corporate receivables by age past due date, per customer. On-account receipts and credit notes are shown as negative lines so the total ties to ledger 1120. */
export async function tradeAging(ctx: Ctx, asOf = new Date()) {
  assertPermission(ctx, "ledger:view");
  const open = await tinv(ctx.orgId).find({ status: { $in: ["open", "partially_paid"] } } as never, { limit: 10000 });
  const labels = ["current", "1-30 overdue", "31-60 overdue", "61-90 overdue", "90+ overdue"];
  const buckets = labels.map((label) => ({ label, amount: money(0), count: 0 }));
  const per = new Map<string, Decimal>();
  for (const i of open) {
    const late = Math.floor((asOf.getTime() - i.dueDate.getTime()) / 86400000);
    const k = late <= 0 ? 0 : late <= 30 ? 1 : late <= 60 ? 2 : late <= 90 ? 3 : 4;
    const b = fromDecimal128(i.balance);
    buckets[k].amount = buckets[k].amount.plus(b); buckets[k].count++;
    per.set(i.customerId, (per.get(i.customerId) ?? money(0)).plus(b));
  }
  const onAcct = sum([...(await rcts(ctx.orgId).find({ unapplied: { $gt: toDecimal128(money(0)) } } as never, { limit: 10000 })).map((r) => fromDecimal128(r.unapplied)),
    ...(await tcn(ctx.orgId).find({ unapplied: { $gt: toDecimal128(money(0)) } } as never, { limit: 10000 })).map((r) => fromDecimal128(r.unapplied))]);
  const names = new Map((await customers(ctx.orgId).find({} as never, { limit: 5000 })).map((c) => [c._id, c.name]));
  return {
    buckets, byCustomer: [...per].map(([id, amount]) => ({ customerId: id, name: names.get(id) ?? "?", amount })).sort((a, b) => b.amount.comparedTo(a.amount)),
    onAccount: onAcct, total: sum(buckets.map((b) => b.amount)).minus(onAcct),
  };
}

export async function customerStatement(ctx: Ctx, customerId: string) {
  assertPermission(ctx, "ledger:view");
  const customer = await needCustomer(ctx, customerId);
  const [invoices, receipts, notes] = await Promise.all([
    tinv(ctx.orgId).find({ customerId, status: { $ne: "void" } } as never, { sort: { issueDate: 1 } }),
    rcts(ctx.orgId).find({ customerId } as never, { sort: { date: 1 } }),
    tcn(ctx.orgId).find({ customerId } as never, { sort: { date: 1 } }),
  ]);
  type Row = { date: Date; ref: string; kind: string; debit: Decimal; credit: Decimal };
  const rows: Row[] = [
    ...invoices.filter((i) => i.status !== "draft").map((i) => ({ date: i.issueDate, ref: i.number, kind: "Invoice", debit: fromDecimal128(i.total), credit: money(0) })),
    ...receipts.map((r) => ({ date: r.date, ref: r.number, kind: "Receipt", debit: money(0), credit: fromDecimal128(r.amount) })),
    ...notes.map((n) => ({ date: n.date, ref: n.number, kind: "Credit note", debit: money(0), credit: fromDecimal128(n.total) })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());
  let run = money(0);
  const lines = rows.map((r) => { run = run.plus(r.debit).minus(r.credit); return { ...r, balance: run }; });
  return { customer, lines, balance: run };
}

/** Headline numbers from the ledger itself. */
export async function booksSummary(ctx: Ctx) {
  assertPermission(ctx, "ledger:view");
  const tb = await trialBalance(ctx, {});
  const bal = (codes: string[]) => sum(tb.rows.filter((r) => codes.includes(r.code)).map((r) => r.balance));
  const now = new Date();
  const ytd = await pnl(ctx, { from: new Date(`${day(now).slice(0, 4)}-01-01T00:00:00+04:00`), to: new Date(now.getTime() + 86400000) });
  return {
    cash: bal(["1000", "1010", "1015", "1016"]),
    receivables: bal(["1100", "1110", "1120"]),
    payables: bal(["2000"]).negated(),
    vatPayable: bal(["2100"]).negated().minus(bal(["1600"])),
    income: ytd.income, expense: ytd.expense, net: ytd.net,
  };
}
