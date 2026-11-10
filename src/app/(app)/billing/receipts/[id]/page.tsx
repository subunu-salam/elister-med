import { requireCtx } from "@/lib/session";
import { fromDecimal128 } from "@/core/money";
import { getPatient } from "@/modules/patients/service";
import { getReceipt } from "@/modules/billing/payment";
import { PrintButton } from "./PrintButton";
import Link from "next/link";
import { NoAccess, aed } from "@/ui/kit";
import { LogoAuto } from "@/ui/brand";

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  if (!ctx.permissions.includes("billing:view")) return <NoAccess what="receipts" />;
  const { payment: p, invoice, org } = await getReceipt(ctx, id);
  const patient = await getPatient(ctx, p.patientId);
  return (
    <div className="mx-auto max-w-md space-y-3">
      <div className="no-print flex justify-between"><Link href={`/billing/invoices/${p.invoiceId}`} className="text-sm text-primary hover:underline">← Invoice</Link><PrintButton /></div>
      <article className="rounded-ui border border-border bg-surface p-6 text-sm" aria-label="Receipt">
        <header className="mb-4 border-b border-border pb-3 text-center">
          <div className="mb-2 flex justify-center"><LogoAuto className="h-12" /></div>
          <h1 className="sr-only">{org?.name ?? "Receipt"}</h1>
          {org?.address && <p className="text-xs text-muted">{org.address}</p>}
          {(org?.phone || org?.website) && <p className="text-xs text-muted">{[org?.phone, org?.website].filter(Boolean).join(" · ")}</p>}
          {org?.trn && <p className="text-xs text-muted">TRN {org.trn}</p>}
          <p className="mt-1 font-mono text-base">{p.receiptNo}</p>
        </header>
        <dl className="grid grid-cols-2 gap-y-1.5">
          <dt className="text-muted">Date</dt><dd className="text-end">{new Date(p.at).toLocaleString("en-GB", { timeZone: "Asia/Dubai" })}</dd>
          <dt className="text-muted">Patient</dt><dd className="text-end">{patient.fullName}</dd>
          <dt className="text-muted">MRN</dt><dd className="text-end font-mono">{patient.mrn}</dd>
          <dt className="text-muted">Invoice</dt><dd className="text-end font-mono">{invoice?.number}</dd>
          <dt className="text-muted">Method</dt><dd className="text-end capitalize">{p.method}</dd>
          <dt className="font-medium">Amount received</dt><dd className="text-end text-base font-semibold">{aed(fromDecimal128(p.amount).toFixed(2))}</dd>
          {fromDecimal128(p.advance).gt(0) && <><dt className="text-muted">Held as advance</dt><dd className="text-end">{aed(fromDecimal128(p.advance).toFixed(2))}</dd></>}
          <dt className="text-muted">Invoice balance</dt><dd className="text-end">{aed(fromDecimal128(invoice?.balance).toFixed(2))}</dd>
        </dl>
        <p className="mt-4 text-center text-xs text-muted">Thank you. Keep this receipt for your records.</p>
      </article>
    </div>
  );
}
