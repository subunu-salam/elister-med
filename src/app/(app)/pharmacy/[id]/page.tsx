import { requireCtx } from "@/lib/session";
import { Alert, Badge, Card, NoAccess, PageHeader, Table } from "@/ui/kit";
import { ActionButton, ActionForm } from "@/ui/forms";
import { getPrescription } from "@/modules/pharmacy/service";
import { getPatient } from "@/modules/patients/service";

export default async function RxPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const { error } = await searchParams;
  if (!ctx.permissions.includes("pharmacy:view")) return <NoAccess what="prescriptions" />;
  const rx = await getPrescription(ctx, id);
  const p = await getPatient(ctx, rx.patientId).catch(() => null);
  const back = `/pharmacy/${id}`;
  const can = (x: string) => ctx.permissions.includes(x as never);
  const blocking = rx.alerts.some((a) => a.blocking);

  return (
    <div className="space-y-4">
      <PageHeader title={<>Prescription <span className="font-mono">{rx.number}</span></>} sub={p ? `${p.fullName} · ${p.mrn}` : undefined} actions={<Badge tone={rx.status === "dispensed" ? "ok" : rx.status === "draft" ? "neutral" : "info"}>{rx.status.replace("_", " ")}</Badge>} />
      {error && <Alert>{error}</Alert>}
      {rx.alerts.map((a, i) => <Alert key={i} tone={a.blocking ? "danger" : "warn"}>{a.message}</Alert>)}
      <Card title="Lines">
        <Table head={["Medicine", "Dose", "Frequency", "Days", "Prescribed", "Dispensed", "Substitution"]}>
          {rx.lines.map((l) => <tr key={l.itemId}><td>{l.name}</td><td>{l.dose}</td><td>{l.frequency}</td><td>{l.durationDays}</td><td>{l.qty}</td><td>{l.dispensed}</td><td>{l.substitutionAllowed ? "allowed" : "no"}</td></tr>)}
        </Table>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        {rx.status === "draft" && can("emr:approve") && (
          <Card title="Prescriber: sign">
            <ActionForm action="rx.sign" back={back} hidden={{ id }} submit="Sign prescription" fields={blocking ? [{ name: "override", label: "Allergy override reason (required)", required: true, span: 3 }] : []} />
            <p className="mt-2 text-xs text-muted">Only the prescriber can sign. Nothing is signed automatically.</p>
          </Card>
        )}
        {rx.status === "signed" && can("pharmacy:approve") && (
          <Card title="Pharmacist: verify"><ActionForm action="rx.verify" back={back} hidden={{ id }} submit="Verify" fields={[{ name: "confirmed", label: "Patient identity and allergies checked", type: "checkbox", span: 3 }]} /></Card>
        )}
        {["verified", "partially_dispensed"].includes(rx.status) && can("pharmacy:update") && (
          <Card title="Dispense">
            {rx.lines.filter((l) => l.dispensed < l.qty).map((l) => (
              <div key={l.itemId} className="mb-2 border-b border-border pb-2 last:border-0">
                <p className="mb-1 text-sm font-medium">{l.name} <span className="text-muted">({l.qty - l.dispensed} left)</span></p>
                <ActionForm inline action="rx.dispense" back={back} hidden={{ id, itemId: l.itemId }} submit="Dispense" fields={[{ name: "qty", label: "Qty", type: "number", required: true, defaultValue: l.qty - l.dispensed }, { name: "location", label: "Stock location", required: true, defaultValue: "pharmacy" }, ...(l.substitutionAllowed ? [{ name: "substitute", label: "Substitute item ID" }] : [])]} />
              </div>
            ))}
            <p className="text-xs text-muted">Batches are taken earliest-expiry first; expired stock is never used; stock cannot go negative.</p>
          </Card>
        )}
        {["dispensed", "partially_dispensed"].includes(rx.status) && can("pharmacy:update") && (
          <Card title="Refill">
            <ActionButton action="rx.refundRequest" back={back} hidden={{ id }}>Request refill</ActionButton>
            <p className="mt-2 text-xs text-muted">A refill request goes to the prescriber, who creates a new draft prescription to review and sign.</p>
          </Card>
        )}
      </div>
    </div>
  );
}
