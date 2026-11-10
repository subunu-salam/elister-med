import Decimal from "decimal.js";
import type { ClientSession } from "mongodb";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { emit } from "@/core/outbox";
import { nextSeq } from "@/core/counters";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { fromDecimal128, money, round2, sum, toDecimal128 } from "@/core/money";
import { dubaiParts } from "@/core/time";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { accountBySystem } from "@/modules/ledger/accounts";
import { postJournalSystem, type LineInput } from "@/modules/ledger/journal";
import type { Charge } from "./charges";
import type { CreditNote, Invoice, InvoiceLine } from "./types";

export const invoices = (orgId: string) => tenantCol<Invoice>(orgId, "invoices");
const charges = (orgId: string) => tenantCol<Charge>(orgId, "charges");

export const yearOf = (d = new Date()) => dubaiParts(d).ymd.slice(0, 4);
export const docNo = (prefix: string, year: string, n: number) => `${prefix}-${year}-${String(n).padStart(6, "0")}`;

/** Revenue (net) rolled up per account + doctor + department so reports can slice by dimension. */
async function postingLines(orgId: string, lines: InvoiceLine[], branchId: string): Promise<LineInput[] & { amount?: never }[]> {
  const groups = new Map<string, { system: string; doctorId?: string; departmentId?: string; amount: Decimal }>();
  for (const l of lines) {
    const k = [l.revenueAccountSystem, l.doctorId ?? "", l.departmentId ?? ""].join("|");
    const g = groups.get(k) ?? { system: l.revenueAccountSystem, doctorId: l.doctorId, departmentId: l.departmentId, amount: money(0) };
    g.amount = g.amount.plus(fromDecimal128(l.net));
    groups.set(k, g);
  }
  const out: (LineInput & { _amount: Decimal })[] = [];
  for (const g of groups.values()) {
    out.push({ accountId: (await accountBySystem(orgId, g.system))._id, _amount: g.amount, dims: { branchId, doctorId: g.doctorId, departmentId: g.departmentId } });
  }
  return out as never;
}
const asCredit = (ls: LineInput[]): LineInput[] => (ls as (LineInput & { _amount: Decimal })[]).map(({ _amount, ...l }) => ({ ...l, credit: _amount.toFixed(2) }));
const asDebit = (ls: LineInput[]): LineInput[] => (ls as (LineInput & { _amount: Decimal })[]).map(({ _amount, ...l }) => ({ ...l, debit: _amount.toFixed(2) }));

/** Insurance split: the insurance module supplies the payer portion for the finalized lines. */
export type PayerSplit = { policyId: string; payerId: string; compute: (lines: InvoiceLine[], total: Decimal) => Decimal };

export async function finalizeInvoice(ctx: Ctx, input: { patientId: string; chargeIds: string[]; insurance?: PayerSplit }): Promise<Invoice> {
  assertPermission(ctx, "billing:create");
  const ids = [...new Set(input.chargeIds)];
  if (ids.length === 0) throw new AppError("VALIDATION", "Select at least one charge");

  const existingFor = (cs: Charge[]) => {
    const inv = cs[0]?.invoiceId;
    return cs.every((c) => c.status === "invoiced" && c.invoiceId && c.invoiceId === inv) ? inv : undefined;
  };
  const load = async (s?: ClientSession) => {
    const cs = await charges(ctx.orgId).find({ _id: { $in: ids }, patientId: input.patientId } as never, { session: s });
    if (cs.length !== ids.length) throw new AppError("NOT_FOUND", "One or more charges not found for this patient");
    return cs;
  };

  const pre = await load();
  const preInv = existingFor(pre);
  if (preInv) return (await invoices(ctx.orgId).findOne({ _id: preInv } as never))!;

  return withTransaction(async (s) => {
    const cs = await load(s);
    const already = existingFor(cs);
    if (already) return (await invoices(ctx.orgId).findOne({ _id: already } as never, s))!;
    if (cs.some((c) => c.status !== "unbilled")) throw new AppError("CONFLICT", "Some charges are already invoiced or void");

    const lines: InvoiceLine[] = cs.map((c) => {
      const net = round2(fromDecimal128(c.unitPrice).times(c.qty));
      const vat = round2(net.times(fromDecimal128(c.taxRate)).div(100));
      return {
        chargeId: c._id, serviceCode: c.serviceCode, name: c.name, qty: c.qty, unitPrice: c.unitPrice, taxCode: c.taxCode, taxRate: c.taxRate, doctorId: c.doctorId, departmentId: c.departmentId,
        net: toDecimal128(net), vat: toDecimal128(vat), gross: toDecimal128(net.plus(vat)), revenueAccountSystem: c.revenueAccountSystem,
      };
    });
    const subtotal = sum(lines.map((l) => fromDecimal128(l.net)));
    const vatTotal = sum(lines.map((l) => fromDecimal128(l.vat)));
    const total = subtotal.plus(vatTotal);
    const payerShare = input.insurance ? round2(input.insurance.compute(lines, total)) : money(0);
    if (payerShare.isNegative() || payerShare.gt(total)) throw new AppError("VALIDATION", "Payer share must be between 0 and the invoice total");
    const patientShare = total.minus(payerShare);
    const year = yearOf();
    const number = docNo("INV", year, await nextSeq(ctx.orgId, `invoice:${year}`, s));

    const invId = newId();
    const res = await charges(ctx.orgId).updateMany(
      { _id: { $in: ids }, status: "unbilled" } as never, { $set: { status: "invoiced", invoiceId: invId } } as never, s);
    if (res.modifiedCount !== ids.length) throw new AppError("CONFLICT", "Charges changed concurrently");

    const je = await postJournalSystem(ctx, {
      date: new Date(), memo: `Invoice ${number}`, sourceRef: { type: "invoice", id: invId }, idempotencyKey: `invoice:${invId}`,
      lines: [
        ...(patientShare.gt(0) ? [{ accountId: (await accountBySystem(ctx.orgId, "ar_patient"))._id, debit: patientShare.toFixed(2), dims: { branchId: ctx.branchId } }] : []),
        ...(payerShare.gt(0) ? [{ accountId: (await accountBySystem(ctx.orgId, "ar_insurance"))._id, debit: payerShare.toFixed(2), dims: { branchId: ctx.branchId } }] : []),
        ...asCredit(await postingLines(ctx.orgId, lines, ctx.branchId)),
        ...(vatTotal.gt(0) ? [{ accountId: (await accountBySystem(ctx.orgId, "vat_output"))._id, credit: vatTotal.toFixed(2), dims: { branchId: ctx.branchId } }] : []),
      ],
    }, s);

    const inv: Invoice = {
      _id: invId, number, patientId: input.patientId, status: patientShare.isZero() ? "paid" : "finalized", lines,
      ...(input.insurance ? { policyId: input.insurance.policyId, payerId: input.insurance.payerId, payerShare: toDecimal128(payerShare), patientShare: toDecimal128(patientShare) } : {}),
      subtotal: toDecimal128(subtotal), vatTotal: toDecimal128(vatTotal), total: toDecimal128(total),
      paid: toDecimal128(money(0)), balance: toDecimal128(patientShare), journalEntryId: je._id, createdAt: new Date(), createdBy: ctx.userId,
    };
    await invoices(ctx.orgId).insertOne(inv, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "invoice.finalize", resource: "invoice", resourceId: invId, after: { number, total: total.toFixed(2) } });
    await emit(s, ctx.orgId, "invoice.finalized", { invoiceId: invId });
    return inv;
  });
}

/** Full credit note for an invoice with no payments standing. Refund any payments first. */
export async function issueCreditNote(ctx: Ctx, input: { invoiceId: string; reason: string }): Promise<CreditNote> {
  assertPermission(ctx, "billing:approve");
  if (!input.reason.trim()) throw new AppError("VALIDATION", "Reason required");
  return withTransaction(async (s) => {
    const inv = await invoices(ctx.orgId).findOne({ _id: input.invoiceId } as never, s);
    if (!inv) throw new AppError("NOT_FOUND", "Invoice not found");
    if (inv.status === "credited") throw new AppError("CONFLICT", "Invoice already credited");
    if (inv.payerShare && fromDecimal128(inv.payerShare).gt(0)) throw new AppError("CONFLICT", "Insured invoice: cancel the claim and use the insurance adjustment flow");
    if (inv.status !== "finalized" || !fromDecimal128(inv.paid).isZero()) {
      throw new AppError("CONFLICT", "Refund payments on this invoice before issuing a credit note");
    }
    const flip = await invoices(ctx.orgId).updateOne({ _id: inv._id, status: "finalized" } as never,
      { $set: { status: "credited", balance: toDecimal128(money(0)) } } as never, s);
    if (flip.matchedCount === 0) throw new AppError("CONFLICT", "Invoice changed concurrently");

    const total = fromDecimal128(inv.total), vat = fromDecimal128(inv.vatTotal);
    const year = yearOf();
    const number = docNo("CN", year, await nextSeq(ctx.orgId, `creditnote:${year}`, s));
    const cnId = newId();
    const je = await postJournalSystem(ctx, {
      date: new Date(), memo: `Credit note ${number} for ${inv.number}`, sourceRef: { type: "credit_note", id: cnId }, idempotencyKey: `creditnote:${cnId}`,
      lines: [
        ...asDebit(await postingLines(ctx.orgId, inv.lines, ctx.branchId)),
        ...(vat.gt(0) ? [{ accountId: (await accountBySystem(ctx.orgId, "vat_output"))._id, debit: vat.toFixed(2), dims: { branchId: ctx.branchId } }] : []),
        { accountId: (await accountBySystem(ctx.orgId, "ar_patient"))._id, credit: total.toFixed(2), dims: { branchId: ctx.branchId } },
      ],
    }, s);
    const cn: CreditNote = {
      _id: cnId, number, invoiceId: inv._id, patientId: inv.patientId, reason: input.reason, total: toDecimal128(total),
      vatTotal: toDecimal128(vat), journalEntryId: je._id, at: new Date(), by: ctx.userId,
    };
    await tenantCol<CreditNote>(ctx.orgId, "credit_notes").insertOne(cn, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "invoice.credit_note", resource: "invoice", resourceId: inv._id, after: { number, reason: input.reason } });
    await emit(s, ctx.orgId, "credit_note.issued", { creditNoteId: cnId });
    return cn;
  });
}

export async function getInvoice(ctx: Ctx, id: string): Promise<Invoice> {
  assertPermission(ctx, "billing:view");
  const inv = await invoices(ctx.orgId).findOne({ _id: id } as never);
  if (!inv) throw new AppError("NOT_FOUND", "Invoice not found");
  return inv;
}

export async function listPatientInvoices(ctx: Ctx, patientId: string): Promise<Invoice[]> {
  assertPermission(ctx, "billing:view");
  return invoices(ctx.orgId).find({ patientId } as never, { sort: { createdAt: -1 }, limit: 100 });
}

export async function listOpenInvoices(ctx: Ctx): Promise<Invoice[]> {
  assertPermission(ctx, "billing:view");
  return invoices(ctx.orgId).find({ status: { $in: ["finalized", "partially_paid"] } } as never, { sort: { createdAt: -1 }, limit: 200 });
}
