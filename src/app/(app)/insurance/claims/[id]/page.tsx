import { requireCtx } from "@/lib/session";
import { fromDecimal128 } from "@/core/money";
import { Alert, Badge, Card, NoAccess, PageHeader, Table, aed } from "@/ui/kit";
import { ActionButton, ActionForm, fmtDateTime } from "@/ui/forms";
import { getClaim } from "@/modules/insurance/claims";
import { getPatient } from "@/modules/patients/service";

export default async function ClaimPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const { error } = await searchParams;
  if (!ctx.permissions.includes("insurance:view")) return <NoAccess what="claims" />;
  const c = await getClaim(ctx, id);
  const p = await getPatient(ctx, c.patientId).catch(() => null);
  const back = `/insurance/claims/${id}`;
  const can = (x: string) => ctx.permissions.includes(x as never);

  return (
    <div className="space-y-4">
      <PageHeader title={<>Claim <span className="font-mono">{c.number}</span> <span className="text-sm text-muted">v{c.version}</span></>} sub={p?.fullName} actions={<Badge tone={c.status === "paid" || c.status === "accepted" ? "ok" : c.status === "rejected" ? "danger" : "info"}>{c.status.replace("_", " ")}</Badge>} />
      {error && <Alert>{error}</Alert>}
      {c.validationErrors.length > 0 && <Alert tone="warn"><strong>Validation:</strong> <ul className="ms-4 list-disc">{c.validationErrors.map((e) => <li key={e}>{e}</li>)}</ul></Alert>}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Items">
            <Table head={["Service", "Diagnosis", "Gross", "Patient", "Payer"]}>{c.items.map((i, k) => <tr key={k}><td>{i.name} × {i.qty}</td><td className="text-xs">{i.diagnosisCodes.join(", ") || <span className="text-danger">missing</span>}</td><td className="tabular-nums">{fromDecimal128(i.gross).toFixed(2)}</td><td className="tabular-nums">{fromDecimal128(i.patientShare).toFixed(2)}</td><td className="tabular-nums">{fromDecimal128(i.payerShare).toFixed(2)}</td></tr>)}</Table>
            <dl className="ms-auto mt-3 grid max-w-xs grid-cols-2 gap-y-1 text-sm"><dt className="text-muted">Claimed</dt><dd className="text-end tabular-nums">{aed(fromDecimal128(c.total).toFixed(2))}</dd><dt className="text-muted">Paid</dt><dd className="text-end tabular-nums">{aed(fromDecimal128(c.paid).toFixed(2))}</dd><dt className="font-medium">Outstanding</dt><dd className="text-end font-semibold tabular-nums">{aed(fromDecimal128(c.outstanding).toFixed(2))}</dd></dl>
          </Card>
          <Card title="History">
            <ol className="space-y-1 text-sm">{c.history.map((h, i) => <li key={i}><span className="text-muted">{fmtDateTime(h.at)}</span> — {h.status.replace("_", " ")}{h.note ? ` (${h.note})` : ""}</li>)}</ol>
            {c.submissions.length > 0 && <p className="mt-3 text-xs text-muted">Submissions: {c.submissions.map((s) => `${s.reference} [${s.mode.toUpperCase()}]`).join(", ")}</p>}
            {c.denials.length > 0 && <p className="mt-1 text-xs text-danger">Denials: {c.denials.map((d) => d.reason).join("; ")}</p>}
          </Card>
        </div>
        <div className="space-y-3">
          <Card title="Actions">
            <div className="space-y-3">
              {["draft", "validated"].includes(c.status) && can("insurance:update") && <ActionButton action="claim.validate" back={back} hidden={{ id }}>Validate claim</ActionButton>}
              {c.status === "validated" && can("insurance:update") && <ActionButton action="claim.submit" back={back} hidden={{ id }} variant="primary">Submit (sandbox)</ActionButton>}
              {c.status === "submitted" && can("insurance:update") && <ActionForm action="claim.response" back={back} hidden={{ id }} submit="Record payer response" variant="outline" fields={[{ name: "outcome", label: "Outcome", type: "select", options: ["accepted", "rejected"] }, { name: "reason", label: "Denial reason" }]} />}
              {c.status === "rejected" && can("insurance:update") && <ActionButton action="claim.resubmit" back={back} hidden={{ id }}>Prepare resubmission</ActionButton>}
              {["submitted", "accepted", "partially_paid"].includes(c.status) && can("insurance:approve") && <ActionForm action="claim.remittance" back={back} hidden={{ payerId: c.payerId, claimId: id }} submit="Post remittance" variant="outline" fields={[{ name: "reference", label: "Remittance ref.", required: true }, { name: "paid", label: "Paid AED", required: true }, { name: "denied", label: "Denied AED" }, { name: "reason", label: "Denial reason" }]} />}
              {!["draft", "validated", "paid", "written_off"].includes(c.status) && fromDecimal128(c.outstanding).gt(0) && can("insurance:approve") && <ActionForm action="claim.writeoff" back={back} hidden={{ id }} submit="Write off remainder" variant="danger" fields={[{ name: "reason", label: "Approved reason", required: true }]} />}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
