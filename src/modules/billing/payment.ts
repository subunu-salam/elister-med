import Decimal from "decimal.js";
import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { emit } from "@/core/outbox";
import { nextSeq } from "@/core/counters";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { fromDecimal128, money, toDecimal128 } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { accountBySystem } from "@/modules/ledger/accounts";
import { postJournalSystem, type LineInput } from "@/modules/ledger/journal";
import { docNo, invoices, yearOf } from "./invoice";
import type { Invoice, InvoiceStatus, Payment, PaymentMethod, Refund } from "./types";

const payments = (orgId: string) => tenantCol<Payment>(orgId, "payments");
const refunds = (orgId: string) => tenantCol<Refund>(orgId, "refunds");

const CASH_ACCOUNT: Record<PaymentMethod, string> = { cash: "cash", card: "card_clearing", bank: "bank", link: "bank" };

const Amount = z.string().or(z.number()).transform((v, ctx) => {
  let d: Decimal;
  try { d = money(v); } catch { ctx.addIssue({ code: "custom", message: "Amount is not a number" }); return z.NEVER; }
  if (!d.isFinite() || d.lte(0)) { ctx.addIssue({ code: "custom", message: "Amount must be greater than zero" }); return z.NEVER; }
  if (d.decimalPlaces() > 2) { ctx.addIssue({ code: "custom", message: "Amount has more than 2 decimal places" }); return z.NEVER; }
  return d;
});
const PayInput = z.object({
  invoiceId: z.string(), method: z.enum(["cash", "card", "bank", "link"]), amount: Amount, idempotencyKey: z.string().min(1),
});
const RefundInput = z.object({ paymentId: z.string(), amount: Amount, reason: z.string().trim().min(1), idempotencyKey: z.string().min(1) });

function statusFor(total: Decimal, balance: Decimal): InvoiceStatus {
  if (balance.lte(0)) return "paid";
  return balance.equals(total) ? "finalized" : "partially_paid";
}

export async function recordPayment(
  ctx: Ctx, input: { invoiceId: string; method: PaymentMethod; amount: string | number; idempotencyKey: string },
): Promise<Payment> {
  assertPermission(ctx, "billing:create");
  const p = PayInput.safeParse(input);
  if (!p.success) throw new AppError("VALIDATION", p.error.issues.map((i) => i.message).join("; "));
  const { invoiceId, method, amount, idempotencyKey } = p.data;

  const prior = await payments(ctx.orgId).findOne({ idempotencyKey } as never);
  if (prior) return prior;

  const run = () => withTransaction(async (s) => {
    const again = await payments(ctx.orgId).findOne({ idempotencyKey } as never, s);
    if (again) return again;
    const inv = await invoices(ctx.orgId).findOne({ _id: invoiceId } as never, s);
    if (!inv) throw new AppError("NOT_FOUND", "Invoice not found");
    if (inv.status === "credited") throw new AppError("CONFLICT", "Invoice was credited");
    const balance = fromDecimal128(inv.balance);
    if (balance.lte(0)) throw new AppError("CONFLICT", "Invoice is already settled");

    const applied = Decimal.min(amount, balance);
    const advance = amount.minus(applied);
    const payId = newId();
    const year = yearOf();
    const receiptNo = docNo("RCP", year, await nextSeq(ctx.orgId, `receipt:${year}`, s));
    const dims = { branchId: ctx.branchId };
    const lines: LineInput[] = [
      { accountId: (await accountBySystem(ctx.orgId, CASH_ACCOUNT[method]))._id, debit: amount.toFixed(2), dims },
      { accountId: (await accountBySystem(ctx.orgId, "ar_patient"))._id, credit: applied.toFixed(2), dims },
      ...(advance.gt(0) ? [{ accountId: (await accountBySystem(ctx.orgId, "customer_advance"))._id, credit: advance.toFixed(2), dims }] : []),
    ].filter((l) => !(l.credit === "0.00"));
    const je = await postJournalSystem(ctx, {
      date: new Date(), memo: `Payment ${receiptNo} for ${inv.number}`, sourceRef: { type: "payment", id: payId }, idempotencyKey: `payment:${idempotencyKey}`, lines,
    }, s);

    const newBalance = balance.minus(applied);
    const upd = await invoices(ctx.orgId).updateOne({ _id: inv._id, balance: inv.balance } as never, {
      $set: {
        paid: toDecimal128(fromDecimal128(inv.paid).plus(applied)), balance: toDecimal128(newBalance),
        status: statusFor(fromDecimal128(inv.total), newBalance),
      },
    } as never, s);
    if (upd.matchedCount === 0) throw new AppError("CONFLICT", "Invoice changed concurrently");

    const pay: Payment = {
      _id: payId, invoiceId: inv._id, patientId: inv.patientId, method, amount: toDecimal128(amount), applied: toDecimal128(applied),
      advance: toDecimal128(advance), refunded: toDecimal128(money(0)), refundedAdvance: toDecimal128(money(0)),
      receiptNo, idempotencyKey, journalEntryId: je._id, at: new Date(), by: ctx.userId,
    };
    await payments(ctx.orgId).insertOne(pay, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "payment.record", resource: "payment", resourceId: payId, after: { receiptNo, amount: amount.toFixed(2), method } });
    await emit(s, ctx.orgId, "payment.recorded", { paymentId: payId, invoiceId: inv._id });
    return pay;
  });

  try {
    return await run();
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const won = await payments(ctx.orgId).findOne({ idempotencyKey } as never);
      if (won) return won;
    }
    throw e;
  }
}

/** Refunds reduce the advance first, then re-open the receivable. Never edits the original payment journal. */
export async function refundPayment(
  ctx: Ctx, input: { paymentId: string; amount: string | number; reason: string; idempotencyKey: string },
): Promise<Refund> {
  assertPermission(ctx, "billing:approve");
  const p = RefundInput.safeParse(input);
  if (!p.success) throw new AppError("VALIDATION", p.error.issues.map((i) => i.message).join("; "));
  const { paymentId, amount, reason, idempotencyKey } = p.data;

  const prior = await refunds(ctx.orgId).findOne({ idempotencyKey } as never);
  if (prior) return prior;

  const run = () => withTransaction(async (s) => {
    const again = await refunds(ctx.orgId).findOne({ idempotencyKey } as never, s);
    if (again) return again;
    const pay = await payments(ctx.orgId).findOne({ _id: paymentId } as never, s);
    if (!pay) throw new AppError("NOT_FOUND", "Payment not found");
    const remaining = fromDecimal128(pay.amount).minus(fromDecimal128(pay.refunded));
    if (amount.gt(remaining)) throw new AppError("VALIDATION", "Refund exceeds the unrefunded payment amount");

    const advRemaining = fromDecimal128(pay.advance).minus(fromDecimal128(pay.refundedAdvance));
    const fromAdvance = Decimal.min(amount, advRemaining);
    const fromAr = amount.minus(fromAdvance);
    const dims = { branchId: ctx.branchId };
    const refId = newId();
    const lines: LineInput[] = [
      ...(fromAdvance.gt(0) ? [{ accountId: (await accountBySystem(ctx.orgId, "customer_advance"))._id, debit: fromAdvance.toFixed(2), dims }] : []),
      ...(fromAr.gt(0) ? [{ accountId: (await accountBySystem(ctx.orgId, "ar_patient"))._id, debit: fromAr.toFixed(2), dims }] : []),
      { accountId: (await accountBySystem(ctx.orgId, CASH_ACCOUNT[pay.method]))._id, credit: amount.toFixed(2), dims },
    ];
    const je = await postJournalSystem(ctx, {
      date: new Date(), memo: `Refund of ${pay.receiptNo}: ${reason}`, sourceRef: { type: "refund", id: refId }, idempotencyKey: `refund:${idempotencyKey}`, lines,
    }, s);

    if (fromAr.gt(0)) {
      const inv = (await invoices(ctx.orgId).findOne({ _id: pay.invoiceId } as never, s)) as Invoice;
      const balance = fromDecimal128(inv.balance).plus(fromAr);
      await invoices(ctx.orgId).updateOne({ _id: inv._id } as never, {
        $set: { paid: toDecimal128(fromDecimal128(inv.paid).minus(fromAr)), balance: toDecimal128(balance), status: statusFor(fromDecimal128(inv.total), balance) },
      } as never, s);
    }
    const upd = await payments(ctx.orgId).updateOne({ _id: pay._id, refunded: pay.refunded } as never, {
      $set: { refunded: toDecimal128(fromDecimal128(pay.refunded).plus(amount)), refundedAdvance: toDecimal128(fromDecimal128(pay.refundedAdvance).plus(fromAdvance)) },
    } as never, s);
    if (upd.matchedCount === 0) throw new AppError("CONFLICT", "Payment changed concurrently");

    const ref: Refund = {
      _id: refId, paymentId: pay._id, invoiceId: pay.invoiceId, amount: toDecimal128(amount), reason, idempotencyKey,
      journalEntryId: je._id, at: new Date(), by: ctx.userId,
    };
    await refunds(ctx.orgId).insertOne(ref, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "payment.refund", resource: "payment", resourceId: pay._id, after: { amount: amount.toFixed(2), reason } });
    await emit(s, ctx.orgId, "payment.refunded", { refundId: refId });
    return ref;
  });

  try {
    return await run();
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const won = await refunds(ctx.orgId).findOne({ idempotencyKey } as never);
      if (won) return won;
    }
    throw e;
  }
}

/** Data for a printable receipt. */
export async function getReceipt(ctx: Ctx, paymentId: string) {
  assertPermission(ctx, "billing:view");
  const pay = await payments(ctx.orgId).findOne({ _id: paymentId } as never);
  if (!pay) throw new AppError("NOT_FOUND", "Payment not found");
  const inv = await invoices(ctx.orgId).findOne({ _id: pay.invoiceId } as never);
  const org = await tenantCol<{ name: string; currency: string; trn?: string; address?: string; phone?: string; email?: string; website?: string }>(ctx.orgId, "orgs").findOne({ _id: ctx.orgId } as never);
  return { payment: pay, invoice: inv, org };
}

export async function listInvoicePayments(ctx: Ctx, invoiceId: string): Promise<Payment[]> {
  assertPermission(ctx, "billing:view");
  return payments(ctx.orgId).find({ invoiceId } as never, { sort: { at: 1 } });
}

/** Cash taken (net of cash refunds) by one cashier between two instants. Used for cash drawer reconciliation. */
export async function cashTakenBy(ctx: Ctx, userId: string, from: Date, to: Date) {
  assertPermission(ctx, "billing:view");
  const pays = await payments(ctx.orgId).find({ method: "cash", by: userId, at: { $gte: from, $lte: to } } as never, { limit: 100000 });
  const refs = await refunds(ctx.orgId).find({ by: userId, at: { $gte: from, $lte: to } } as never, { limit: 100000 });
  const refPay = new Map((await payments(ctx.orgId).find({ _id: { $in: refs.map((r) => r.paymentId) } } as never)).map((p) => [p._id, p.method]));
  const cashIn = pays.reduce((a, p) => a.plus(fromDecimal128(p.amount)), money(0));
  const cashOut = refs.filter((r) => refPay.get(r.paymentId) === "cash").reduce((a, r) => a.plus(fromDecimal128(r.amount)), money(0));
  return { cashIn, cashOut, net: cashIn.minus(cashOut) };
}
