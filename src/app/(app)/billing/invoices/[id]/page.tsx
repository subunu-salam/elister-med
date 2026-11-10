import Link from "next/link";
import { randomUUID } from "node:crypto";
import { requireCtx } from "@/lib/session";
import { fromDecimal128 } from "@/core/money";
import { getPatient } from "@/modules/patients/service";
import { getInvoice } from "@/modules/billing/invoice";
import { listInvoicePayments } from "@/modules/billing/payment";
import { Alert, Badge, Button, Card, Field, Input, NoAccess, PageHeader, Select, Table, aed } from "@/ui/kit";
import { creditNoteAction, payAction, refundAction } from "../../actions";

const fmt = (d: Date) => new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" });
const m = (v: Parameters<typeof fromDecimal128>[0]) => fromDecimal128(v).toFixed(2);

export default async function InvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const { error } = await searchParams;
  if (!ctx.permissions.includes("billing:view")) return <NoAccess what="invoices" />;
  const inv = await getInvoice(ctx, id);
  const patient = await getPatient(ctx, inv.patientId);
  const pays = await listInvoicePayments(ctx, id);
  const can = (p: string) => ctx.permissions.includes(p as never);
  const balance = fromDecimal128(inv.balance);
  const settleable = inv.status !== "credited" && balance.gt(0);

  return (
    <div className="space-y-4">
      <PageHeader title={<>Invoice <span className="font-mono">{inv.number}</span></>} sub={<>{patient.fullName} · {fmt(inv.createdAt)}</>}
        actions={<Badge tone={inv.status === "paid" ? "ok" : inv.status === "credited" ? "neutral" : "warn"}>{inv.status.replace("_", " ")}</Badge>} />
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Lines">
            <Table head={["Service", "Qty", "Net", "VAT", "Gross"]}>
              {inv.lines.map((l) => <tr key={l.chargeId}><td>{l.name}</td><td>{l.qty}</td><td className="tabular-nums">{m(l.net)}</td><td className="tabular-nums">{m(l.vat)} <span className="text-xs text-muted">({fromDecimal128(l.taxRate).toFixed(0)}%)</span></td><td className="tabular-nums">{m(l.gross)}</td></tr>)}
            </Table>
            <dl className="mt-3 ms-auto grid max-w-xs grid-cols-2 gap-y-1 text-sm">
              <dt className="text-muted">Subtotal</dt><dd className="text-end tabular-nums">{aed(m(inv.subtotal))}</dd>
              <dt className="text-muted">VAT</dt><dd className="text-end tabular-nums">{aed(m(inv.vatTotal))}</dd>
              <dt className="font-medium">Total</dt><dd className="text-end font-semibold tabular-nums">{aed(m(inv.total))}</dd>
              <dt className="text-muted">Paid</dt><dd className="text-end tabular-nums">{aed(m(inv.paid))}</dd>
              <dt className="font-medium">Balance</dt><dd className="text-end font-semibold tabular-nums">{aed(m(inv.balance))}</dd>
            </dl>
            <p className="mt-3 text-xs text-muted">VAT rates shown are configured defaults and require review by a UAE tax professional. This is not a compliant structured e-invoice.</p>
          </Card>
          <Card title="Payments">
            <Table head={["Receipt", "Method", "Amount", "Refunded", ""]} empty={pays.length ? undefined : "No payments yet."}>
              {pays.map((p) => (
                <tr key={p._id}>
                  <td><Link className="text-primary hover:underline" href={`/billing/receipts/${p._id}`}>{p.receiptNo}</Link><div className="text-xs text-muted">{fmt(p.at)}</div></td>
                  <td className="capitalize">{p.method}</td><td className="tabular-nums">{aed(m(p.amount))}{fromDecimal128(p.advance).gt(0) && <div className="text-xs text-muted">incl. {aed(m(p.advance))} advance</div>}</td>
                  <td className="tabular-nums">{aed(m(p.refunded))}</td>
                  <td>
                    {can("billing:approve") && fromDecimal128(p.amount).minus(fromDecimal128(p.refunded)).gt(0) && (
                      <form action={refundAction} className="flex gap-1">
                        <input type="hidden" name="invoiceId" value={inv._id} /><input type="hidden" name="paymentId" value={p._id} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
                        <Input name="amount" required placeholder="Amount" className="h-7 w-20 py-1 text-xs" aria-label="Refund amount" /><Input name="reason" required placeholder="Reason" className="h-7 w-28 py-1 text-xs" aria-label="Refund reason" />
                        <Button variant="ghost" className="px-2 py-1 text-xs">Refund</Button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
        <div className="space-y-4">
          {settleable && can("billing:create") && (
            <Card title="Record payment">
              <form action={payAction} className="space-y-3">
                <input type="hidden" name="invoiceId" value={inv._id} /><input type="hidden" name="idempotencyKey" value={randomUUID()} />
                <Field label="Method"><Select name="method"><option value="cash">Cash</option><option value="card">Card</option><option value="bank">Bank transfer</option><option value="link">Payment link</option></Select></Field>
                <Field label="Amount (AED)" hint="Use the remaining balance, or enter part of it for a split payment."><Input name="amount" required inputMode="decimal" defaultValue={balance.toFixed(2)} /></Field>
                <Button className="w-full">Record payment</Button>
              </form>
            </Card>
          )}
          {inv.status === "finalized" && can("billing:approve") && (
            <Card title="Credit note">
              <form action={creditNoteAction} className="space-y-3">
                <input type="hidden" name="invoiceId" value={inv._id} />
                <Field label="Reason"><Input name="reason" required /></Field>
                <Button variant="danger" className="w-full">Issue credit note</Button>
              </form>
              <p className="mt-2 text-xs text-muted">Reverses revenue, VAT and receivable. Refund any payments first.</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
