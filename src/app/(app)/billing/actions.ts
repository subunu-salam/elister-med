"use server";
import { run, requireCtx } from "@/lib/session";
import { finalizeInvoice, issueCreditNote } from "@/modules/billing/invoice";
import { recordPayment, refundPayment } from "@/modules/billing/payment";

export async function finalizeAction(fd: FormData) {
  const ctx = await requireCtx();
  const patientId = String(fd.get("patientId"));
  await run(`/billing?patientId=${patientId}`, async () => {
    const inv = await finalizeInvoice(ctx, { patientId, chargeIds: fd.getAll("chargeId").map(String) });
    return `/billing/invoices/${inv._id}`;
  });
}

export async function payAction(fd: FormData) {
  const ctx = await requireCtx();
  const invoiceId = String(fd.get("invoiceId"));
  await run(`/billing/invoices/${invoiceId}`, async () => {
    const pay = await recordPayment(ctx, {
      invoiceId, method: String(fd.get("method")) as "cash" | "card" | "bank" | "link",
      amount: String(fd.get("amount")), idempotencyKey: String(fd.get("idempotencyKey")),
    });
    return `/billing/receipts/${pay._id}`;
  });
}

export async function refundAction(fd: FormData) {
  const ctx = await requireCtx();
  const invoiceId = String(fd.get("invoiceId"));
  await run(`/billing/invoices/${invoiceId}`, async () => {
    await refundPayment(ctx, { paymentId: String(fd.get("paymentId")), amount: String(fd.get("amount")), reason: String(fd.get("reason") ?? ""), idempotencyKey: String(fd.get("idempotencyKey")) });
  });
}

export async function creditNoteAction(fd: FormData) {
  const ctx = await requireCtx();
  const invoiceId = String(fd.get("invoiceId"));
  await run(`/billing/invoices/${invoiceId}`, async () => { await issueCreditNote(ctx, { invoiceId, reason: String(fd.get("reason") ?? "") }); });
}
