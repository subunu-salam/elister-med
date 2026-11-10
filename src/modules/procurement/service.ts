import Decimal from "decimal.js";
import type { Decimal128 } from "mongodb";
import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { emit } from "@/core/outbox";
import { nextSeq } from "@/core/counters";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { fromDecimal128, money, sum, toDecimal128 } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { accountBySystem } from "@/modules/ledger/accounts";
import { postJournalSystem } from "@/modules/ledger/journal";
import { docNo, yearOf } from "@/modules/billing/invoice";
import { inventoryAccountSystem, receiveIntoStock, reorderAlerts, type Item } from "@/modules/inventory/service";

export type Supplier = { _id: string; name: string; trn?: string; termsDays: number; active: boolean };
export type PRLine = { itemId: string; qty: number };
export type PurchaseRequest = { _id: string; number: string; lines: PRLine[]; status: "draft" | "approved" | "rejected" | "ordered"; note?: string; auto?: boolean; requestedBy: string; decidedBy?: string; createdAt: Date };
export type POLine = { itemId: string; qty: number; unitCost: Decimal128; received: number };
export type PurchaseOrder = {
  _id: string; number: string; supplierId: string; prId?: string; lines: POLine[]; status: "draft" | "issued" | "partially_received" | "received";
  receivedValue: Decimal128; invoicedValue: Decimal128; createdBy: string; createdAt: Date;
};
export type Grn = { _id: string; number: string; poId: string; locationId: string; lines: { itemId: string; batchId: string; qty: number; unitCost: Decimal128 }[]; value: Decimal128; idempotencyKey: string; journalEntryId: string; at: Date; by: string };
export type SupplierInvoice = {
  _id: string; supplierId: string; poId?: string; invoiceNo: string; invoiceDate: Date; dueDate: Date; net: Decimal128; vat: Decimal128; total: Decimal128; paid: Decimal128; balance: Decimal128;
  status: "pending_approval" | "approved" | "partially_paid" | "paid" | "rejected"; journalEntryId?: string; recordedBy: string; approvedBy?: string; createdAt: Date;
};
export type SupplierPayment = { _id: string; invoiceId: string; supplierId: string; amount: Decimal128; method: "bank" | "cash"; idempotencyKey: string; journalEntryId: string; at: Date; by: string };

const suppliers = (o: string) => tenantCol<Supplier>(o, "suppliers");
const prs = (o: string) => tenantCol<PurchaseRequest>(o, "purchase_requests");
const pos = (o: string) => tenantCol<PurchaseOrder>(o, "purchase_orders");
const grns = (o: string) => tenantCol<Grn>(o, "grns");
const sinv = (o: string) => tenantCol<SupplierInvoice>(o, "supplier_invoices");
const spay = (o: string) => tenantCol<SupplierPayment>(o, "supplier_payments");
const v = <T>(r: { success: true; data: T } | { success: false; error: { message: string } }): T => { if (!r.success) throw new AppError("VALIDATION", r.error.message); return r.data; };
const amt = z.string().regex(/^\d+(\.\d{1,2})?$/);

export async function createSupplier(ctx: Ctx, input: { name: string; trn?: string; termsDays?: number }): Promise<Supplier> {
  assertPermission(ctx, "procurement:create");
  const d = v(z.object({ name: z.string().min(2), trn: z.string().optional(), termsDays: z.number().int().min(0).max(365).default(30) }).safeParse(input));
  const s0: Supplier = { _id: newId(), ...d, active: true };
  await withTransaction(async (s) => {
    await suppliers(ctx.orgId).insertOne(s0, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "supplier.create", resource: "supplier", resourceId: s0._id, after: { name: s0.name } });
  });
  return s0;
}

async function createPR(ctx: Ctx, lines: PRLine[], note: string | undefined, auto: boolean): Promise<PurchaseRequest> {
  if (!lines.length || lines.some((l) => !Number.isInteger(l.qty) || l.qty <= 0)) throw new AppError("VALIDATION", "Lines need positive whole quantities");
  return withTransaction(async (s) => {
    const year = yearOf();
    const pr: PurchaseRequest = { _id: newId(), number: docNo("PR", year, await nextSeq(ctx.orgId, `pr:${year}`, s)), lines, status: "draft", note, auto, requestedBy: ctx.userId, createdAt: new Date() };
    await prs(ctx.orgId).insertOne(pr, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "pr.create", resource: "purchase_request", resourceId: pr._id, after: { number: pr.number, auto } });
    await emit(s, ctx.orgId, "pr.created", { prId: pr._id });
    return pr;
  });
}

export async function createPurchaseRequest(ctx: Ctx, input: { lines: PRLine[]; note?: string }) {
  assertPermission(ctx, "procurement:create");
  return createPR(ctx, input.lines, input.note, false);
}

/** Scenario E step 1-2: items at or below their reorder level without an open request get one draft PR. */
export async function createReorderRequests(ctx: Ctx): Promise<PurchaseRequest | null> {
  assertPermission(ctx, "procurement:create");
  const alerts = await reorderAlerts(ctx);
  const open = await prs(ctx.orgId).find({ status: { $in: ["draft", "approved"] } } as never);
  const covered = new Set(open.flatMap((p) => p.lines.map((l) => l.itemId)));
  const lines = alerts.filter((a) => !covered.has(a.item._id) && a.item.reorderQty > 0).map((a) => ({ itemId: a.item._id, qty: a.item.reorderQty }));
  return lines.length ? createPR(ctx, lines, "Auto-generated: stock at or below reorder level", true) : null;
}

/** Four-eyes: the requester cannot approve their own request. */
export async function decidePurchaseRequest(ctx: Ctx, id: string, approved: boolean): Promise<void> {
  assertPermission(ctx, "procurement:approve");
  await withTransaction(async (s) => {
    const pr = await prs(ctx.orgId).findOne({ _id: id } as never, s);
    if (!pr) throw new AppError("NOT_FOUND", "Purchase request not found");
    if (pr.requestedBy === ctx.userId) throw new AppError("FORBIDDEN", "You cannot approve your own request");
    const res = await prs(ctx.orgId).updateOne({ _id: id, status: "draft" } as never, { $set: { status: approved ? "approved" : "rejected", decidedBy: ctx.userId } } as never, s);
    if (res.matchedCount === 0) throw new AppError("CONFLICT", "Request already decided");
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: approved ? "pr.approve" : "pr.reject", resource: "purchase_request", resourceId: id });
  });
}

export async function createPurchaseOrder(ctx: Ctx, input: { supplierId: string; prId?: string; lines: { itemId: string; qty: number; unitCost: string }[] }): Promise<PurchaseOrder> {
  assertPermission(ctx, "procurement:create");
  const d = v(z.object({ supplierId: z.string(), prId: z.string().optional(), lines: z.array(z.object({ itemId: z.string(), qty: z.number().int().positive(), unitCost: amt })).min(1) }).safeParse(input));
  if (!(await suppliers(ctx.orgId).findOne({ _id: d.supplierId } as never))) throw new AppError("NOT_FOUND", "Supplier not found");
  return withTransaction(async (s) => {
    if (d.prId) {
      const pr = await prs(ctx.orgId).findOne({ _id: d.prId } as never, s);
      if (!pr) throw new AppError("NOT_FOUND", "Purchase request not found");
      if (pr.status !== "approved") throw new AppError("CONFLICT", "Purchase request is not approved");
      await prs(ctx.orgId).updateOne({ _id: pr._id } as never, { $set: { status: "ordered" } } as never, s);
    }
    const year = yearOf();
    const po: PurchaseOrder = {
      _id: newId(), number: docNo("PO", year, await nextSeq(ctx.orgId, `po:${year}`, s)), supplierId: d.supplierId, prId: d.prId,
      lines: d.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, unitCost: toDecimal128(money(l.unitCost)), received: 0 })), status: "draft",
      receivedValue: toDecimal128(money(0)), invoicedValue: toDecimal128(money(0)), createdBy: ctx.userId, createdAt: new Date(),
    };
    await pos(ctx.orgId).insertOne(po, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "po.create", resource: "purchase_order", resourceId: po._id, after: { number: po.number } });
    return po;
  });
}

export async function issuePurchaseOrder(ctx: Ctx, id: string): Promise<void> {
  assertPermission(ctx, "procurement:update");
  await withTransaction(async (s) => {
    const res = await pos(ctx.orgId).updateOne({ _id: id, status: "draft" } as never, { $set: { status: "issued" } } as never, s);
    if (res.matchedCount === 0) throw new AppError("CONFLICT", "Order not found or already issued");
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "po.issue", resource: "purchase_order", resourceId: id });
  });
}

/** Goods receipt: stock up at PO cost, Dr Inventory / Cr GRNI. Cannot exceed ordered quantity. Idempotent per key. */
export async function receiveGoods(
  ctx: Ctx, input: { poId: string; locationId: string; idempotencyKey: string; lines: { itemId: string; qty: number; batchNo: string; expiry: Date }[] },
): Promise<Grn> {
  assertPermission(ctx, "procurement:update");
  const prior = await grns(ctx.orgId).findOne({ idempotencyKey: input.idempotencyKey } as never);
  if (prior) return prior;
  const run = () => withTransaction(async (s) => {
    const again = await grns(ctx.orgId).findOne({ idempotencyKey: input.idempotencyKey } as never, s);
    if (again) return again;
    const po = await pos(ctx.orgId).findOne({ _id: input.poId } as never, s);
    if (!po) throw new AppError("NOT_FOUND", "Purchase order not found");
    if (!["issued", "partially_received"].includes(po.status)) throw new AppError("CONFLICT", `Order is ${po.status}`);
    const grnId = newId();
    const glines: Grn["lines"] = [];
    const byAccount = new Map<string, Decimal>();
    let value = money(0);
    const newLines = po.lines.map((l) => ({ ...l }));
    for (const l of input.lines) {
      const pl = newLines.find((x) => x.itemId === l.itemId);
      if (!pl) throw new AppError("VALIDATION", "Item is not on this order");
      if (pl.received + l.qty > pl.qty) throw new AppError("VALIDATION", "Receipt exceeds ordered quantity");
      pl.received += l.qty;
      const item = (await tenantCol<Item>(ctx.orgId, "inv_items").findOne({ _id: l.itemId } as never, s))!;
      const { batch, value: val } = await receiveIntoStock(ctx, { itemId: l.itemId, locationId: input.locationId, batchNo: l.batchNo, expiry: l.expiry, qty: l.qty, unitCost: fromDecimal128(pl.unitCost), supplierId: po.supplierId, refType: "grn", refId: grnId }, s);
      glines.push({ itemId: l.itemId, batchId: batch._id, qty: l.qty, unitCost: pl.unitCost });
      value = value.plus(val);
      const sys = inventoryAccountSystem(item);
      byAccount.set(sys, (byAccount.get(sys) ?? money(0)).plus(val));
    }
    const fully = newLines.every((l) => l.received === l.qty);
    const year = yearOf();
    const number = docNo("GRN", year, await nextSeq(ctx.orgId, `grn:${year}`, s));
    const je = await postJournalSystem(ctx, {
      date: new Date(), memo: `Goods receipt ${number} (PO ${po.number})`, sourceRef: { type: "grn", id: grnId }, idempotencyKey: `grn:${input.idempotencyKey}`,
      lines: [
        ...(await Promise.all([...byAccount].map(async ([sys, val]) => ({ accountId: (await accountBySystem(ctx.orgId, sys))._id, debit: val.toFixed(2) })))),
        { accountId: (await accountBySystem(ctx.orgId, "grni"))._id, credit: value.toFixed(2) },
      ],
    }, s);
    const grn: Grn = { _id: grnId, number, poId: po._id, locationId: input.locationId, lines: glines, value: toDecimal128(value), idempotencyKey: input.idempotencyKey, journalEntryId: je._id, at: new Date(), by: ctx.userId };
    await grns(ctx.orgId).insertOne(grn, s);
    await pos(ctx.orgId).updateOne({ _id: po._id } as never, { $set: { lines: newLines, status: fully ? "received" : "partially_received", receivedValue: toDecimal128(fromDecimal128(po.receivedValue).plus(value)) } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "grn.receive", resource: "grn", resourceId: grnId, after: { number, value: value.toFixed(2) } });
    await emit(s, ctx.orgId, "grn.received", { grnId });
    return grn;
  });
  try { return await run(); } catch (e) {
    if ((e as { code?: number }).code === 11000) { const won = await grns(ctx.orgId).findOne({ idempotencyKey: input.idempotencyKey } as never); if (won) return won; }
    throw e;
  }
}

export async function recordSupplierInvoice(ctx: Ctx, input: { supplierId: string; poId?: string; invoiceNo: string; invoiceDate: Date; dueDate: Date; net: string; vat: string }): Promise<SupplierInvoice> {
  assertPermission(ctx, "procurement:create");
  const d = v(z.object({ supplierId: z.string(), poId: z.string().optional(), invoiceNo: z.string().min(1), invoiceDate: z.coerce.date(), dueDate: z.coerce.date(), net: amt, vat: amt }).safeParse(input));
  if (money(d.net).lte(0)) throw new AppError("VALIDATION", "Net amount must be positive");
  if (!(await suppliers(ctx.orgId).findOne({ _id: d.supplierId } as never))) throw new AppError("NOT_FOUND", "Supplier not found");
  const total = money(d.net).plus(d.vat);
  const doc: SupplierInvoice = {
    _id: newId(), supplierId: d.supplierId, poId: d.poId, invoiceNo: d.invoiceNo, invoiceDate: d.invoiceDate, dueDate: d.dueDate,
    net: toDecimal128(money(d.net)), vat: toDecimal128(money(d.vat)), total: toDecimal128(total), paid: toDecimal128(money(0)), balance: toDecimal128(total),
    status: "pending_approval", recordedBy: ctx.userId, createdAt: new Date(),
  };
  try {
    await withTransaction(async (s) => {
      await sinv(ctx.orgId).insertOne(doc, s);
      await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "supplier_invoice.record", resource: "supplier_invoice", resourceId: doc._id, after: { invoiceNo: d.invoiceNo, total: total.toFixed(2) } });
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new AppError("CONFLICT", "This supplier invoice number was already recorded");
    throw e;
  }
  return doc;
}

/** Approval posts to the ledger: Dr GRNI (matched receipts) +/- price variance, Dr Input VAT, Cr AP. Recorder cannot approve. */
export async function approveSupplierInvoice(ctx: Ctx, id: string): Promise<SupplierInvoice> {
  assertPermission(ctx, "procurement:approve");
  return withTransaction(async (s) => {
    const inv = await sinv(ctx.orgId).findOne({ _id: id } as never, s);
    if (!inv) throw new AppError("NOT_FOUND", "Supplier invoice not found");
    if (inv.recordedBy === ctx.userId) throw new AppError("FORBIDDEN", "You cannot approve an invoice you recorded");
    if (inv.status !== "pending_approval") throw new AppError("CONFLICT", `Invoice is ${inv.status}`);
    const net = fromDecimal128(inv.net), vat = fromDecimal128(inv.vat);
    let matched = money(0);
    if (inv.poId) {
      const po = await pos(ctx.orgId).findOne({ _id: inv.poId } as never, s);
      if (!po) throw new AppError("NOT_FOUND", "Purchase order not found");
      const open = fromDecimal128(po.receivedValue).minus(fromDecimal128(po.invoicedValue));
      matched = Decimal.min(open, net);
      await pos(ctx.orgId).updateOne({ _id: po._id } as never, { $set: { invoicedValue: toDecimal128(fromDecimal128(po.invoicedValue).plus(matched)) } } as never, s);
    }
    const variance = net.minus(matched); // >0: invoiced more than received value (or no PO): expense
    const unreceived = !inv.poId; // no PO: expense whole net as variance/expense
    const lines = [
      ...(matched.gt(0) ? [{ accountId: (await accountBySystem(ctx.orgId, "grni"))._id, debit: matched.toFixed(2) }] : []),
      ...(variance.gt(0) ? [{ accountId: (await accountBySystem(ctx.orgId, "purchase_variance"))._id, debit: variance.toFixed(2) }] : []),
      ...(vat.gt(0) ? [{ accountId: (await accountBySystem(ctx.orgId, "vat_input"))._id, debit: vat.toFixed(2) }] : []),
      { accountId: (await accountBySystem(ctx.orgId, "ap"))._id, credit: net.plus(vat).toFixed(2) },
    ];
    void unreceived;
    const je = await postJournalSystem(ctx, { date: new Date(), memo: `Supplier invoice ${inv.invoiceNo}`, sourceRef: { type: "supplier_invoice", id: inv._id }, idempotencyKey: `sinv:${inv._id}`, lines }, s);
    await sinv(ctx.orgId).updateOne({ _id: inv._id, status: "pending_approval" } as never, { $set: { status: "approved", approvedBy: ctx.userId, journalEntryId: je._id } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "supplier_invoice.approve", resource: "supplier_invoice", resourceId: inv._id, after: { matched: matched.toFixed(2), variance: variance.toFixed(2) } });
    await emit(s, ctx.orgId, "supplier_invoice.approved", { invoiceId: inv._id });
    return { ...inv, status: "approved", journalEntryId: je._id };
  });
}

export async function paySupplier(ctx: Ctx, input: { invoiceId: string; amount: string; method: "bank" | "cash"; idempotencyKey: string }): Promise<SupplierPayment> {
  assertPermission(ctx, "ledger:create");
  const d = v(z.object({ invoiceId: z.string(), amount: amt, method: z.enum(["bank", "cash"]), idempotencyKey: z.string().min(1) }).safeParse(input));
  const amount = money(d.amount);
  if (amount.lte(0)) throw new AppError("VALIDATION", "Amount must be positive");
  const prior = await spay(ctx.orgId).findOne({ idempotencyKey: d.idempotencyKey } as never);
  if (prior) return prior;
  const run = () => withTransaction(async (s) => {
    const again = await spay(ctx.orgId).findOne({ idempotencyKey: d.idempotencyKey } as never, s);
    if (again) return again;
    const inv = await sinv(ctx.orgId).findOne({ _id: d.invoiceId } as never, s);
    if (!inv) throw new AppError("NOT_FOUND", "Supplier invoice not found");
    if (!["approved", "partially_paid"].includes(inv.status)) throw new AppError("CONFLICT", `Invoice is ${inv.status}; only approved invoices can be paid`);
    const balance = fromDecimal128(inv.balance);
    if (amount.gt(balance)) throw new AppError("VALIDATION", "Payment exceeds the invoice balance");
    const payId = newId();
    const je = await postJournalSystem(ctx, {
      date: new Date(), memo: `Supplier payment ${inv.invoiceNo}`, sourceRef: { type: "supplier_payment", id: payId }, idempotencyKey: `spay:${d.idempotencyKey}`,
      lines: [{ accountId: (await accountBySystem(ctx.orgId, "ap"))._id, debit: amount.toFixed(2) }, { accountId: (await accountBySystem(ctx.orgId, d.method === "bank" ? "bank" : "cash"))._id, credit: amount.toFixed(2) }],
    }, s);
    const newBal = balance.minus(amount);
    const up = await sinv(ctx.orgId).updateOne({ _id: inv._id, balance: inv.balance } as never, { $set: { balance: toDecimal128(newBal), paid: toDecimal128(fromDecimal128(inv.paid).plus(amount)), status: newBal.isZero() ? "paid" : "partially_paid" } } as never, s);
    if (up.matchedCount === 0) throw new AppError("CONFLICT", "Invoice changed concurrently");
    const pay: SupplierPayment = { _id: payId, invoiceId: inv._id, supplierId: inv.supplierId, amount: toDecimal128(amount), method: d.method, idempotencyKey: d.idempotencyKey, journalEntryId: je._id, at: new Date(), by: ctx.userId };
    await spay(ctx.orgId).insertOne(pay, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "supplier_payment.record", resource: "supplier_payment", resourceId: payId, after: { amount: amount.toFixed(2) } });
    return pay;
  });
  try { return await run(); } catch (e) {
    if ((e as { code?: number }).code === 11000) { const won = await spay(ctx.orgId).findOne({ idempotencyKey: d.idempotencyKey } as never); if (won) return won; }
    throw e;
  }
}

export async function apAging(ctx: Ctx, asOf = new Date()) {
  assertPermission(ctx, "procurement:view");
  const open = await sinv(ctx.orgId).find({ status: { $in: ["approved", "partially_paid"] } } as never, { limit: 10000 });
  const labels = ["current", "1-30 overdue", "31-60 overdue", "60+ overdue"];
  const buckets = labels.map((label) => ({ label, amount: money(0), count: 0 }));
  for (const i of open) {
    const late = Math.floor((asOf.getTime() - i.dueDate.getTime()) / 86400000);
    const k = late <= 0 ? 0 : late <= 30 ? 1 : late <= 60 ? 2 : 3;
    buckets[k].amount = buckets[k].amount.plus(fromDecimal128(i.balance));
    buckets[k].count++;
  }
  return { buckets, total: sum(buckets.map((b) => b.amount)) };
}

export async function supplierStatement(ctx: Ctx, supplierId: string) {
  assertPermission(ctx, "procurement:view");
  const invs = await sinv(ctx.orgId).find({ supplierId } as never, { sort: { invoiceDate: 1 } });
  const pays = await spay(ctx.orgId).find({ supplierId } as never, { sort: { at: 1 } });
  return { invoices: invs, payments: pays, balance: sum(invs.filter((i) => ["approved", "partially_paid", "paid"].includes(i.status)).map((i) => fromDecimal128(i.balance))) };
}

export async function listSuppliers(ctx: Ctx) { assertPermission(ctx, "procurement:view"); return suppliers(ctx.orgId).find({} as never, { sort: { name: 1 } }); }
export async function listPurchaseRequests(ctx: Ctx) { assertPermission(ctx, "procurement:view"); return prs(ctx.orgId).find({} as never, { sort: { createdAt: -1 }, limit: 100 }); }
export async function listPurchaseOrders(ctx: Ctx) { assertPermission(ctx, "procurement:view"); return pos(ctx.orgId).find({} as never, { sort: { createdAt: -1 }, limit: 100 }); }
export async function listSupplierInvoices(ctx: Ctx) { assertPermission(ctx, "procurement:view"); return sinv(ctx.orgId).find({} as never, { sort: { createdAt: -1 }, limit: 100 }); }
export async function listSupplierPayments(ctx: Ctx) { assertPermission(ctx, "procurement:view"); return spay(ctx.orgId).find({} as never, { sort: { at: -1 }, limit: 200 }); }
