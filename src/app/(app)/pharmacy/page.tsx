import Link from "next/link";
import { requireCtx } from "@/lib/session";
import { fromDecimal128 } from "@/core/money";
import { Alert, Badge, Card, NoAccess, PageHeader, Stat, Table, aed } from "@/ui/kit";
import { ActionForm, fmtDateTime } from "@/ui/forms";
import { dispensingQueue, pharmacyDashboard } from "@/modules/pharmacy/service";
import { listItems } from "@/modules/inventory/service";
import { patientNames } from "@/modules/patients/service";

export default async function PharmacyPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireCtx();
  const { error } = await searchParams;
  if (!ctx.permissions.includes("pharmacy:view")) return <NoAccess what="the pharmacy" />;
  const can = (p: string) => ctx.permissions.includes(p as never);
  const [queue, dash, meds] = await Promise.all([dispensingQueue(ctx), pharmacyDashboard(ctx), listItems(ctx, { category: "medicine" })]);
  const names = await patientNames(ctx, queue.map((q) => q.patientId));

  return (
    <div className="space-y-4">
      <PageHeader title="Pharmacy" sub="Doctor signs → pharmacist verifies → dispense (FEFO) → charge → stock and ledger" />
      {error && <Alert>{error}</Alert>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Awaiting verification" value={dash.awaitingVerification} tone={dash.awaitingVerification ? "warn" : undefined} />
        <Stat label="Ready to dispense" value={dash.readyToDispense} />
        <Stat label="Low stock items" value={dash.lowStock} tone={dash.lowStock ? "warn" : undefined} />
        <Stat label="Near expiry (90d)" value={dash.nearExpiry} tone={dash.nearExpiry ? "warn" : undefined} />
        <Stat label="Pharmacy sales" value={aed(dash.pharmacySales)} />
      </div>
      <Card title="Dispensing queue">
        <Table head={["Rx", "Patient", "Lines", "Status", "Signed"]} empty={queue.length ? undefined : "Nothing waiting."}>
          {queue.map((r) => <tr key={r._id}><td><Link className="text-primary hover:underline" href={`/pharmacy/${r._id}`}>{r.number}</Link></td><td>{names.get(r.patientId)?.fullName}</td><td>{r.lines.map((l) => `${l.name} ×${l.qty}`).join(", ")}</td><td><Badge tone={r.status === "signed" ? "warn" : "info"}>{r.status.replace("_", " ")}</Badge></td><td className="text-xs text-muted">{fmtDateTime(r.signedAt)}</td></tr>)}
        </Table>
      </Card>
      {can("pharmacy:create") && meds.length > 0 && (
        <Card title="New prescription (draft)">
          <ActionForm action="rx.create" back="/pharmacy" submit="Create draft" fields={[
            { name: "encounterId", label: "Encounter ID", required: true, hint: "Open from the encounter workspace" },
            { name: "itemId", label: "Medicine", type: "select", options: meds.map((m) => ({ value: m._id, label: `${m.name}${m.strength ? ` ${m.strength}` : ""}` })) },
            { name: "dose", label: "Dose", required: true, placeholder: "1 tablet" }, { name: "frequency", label: "Frequency", required: true, placeholder: "TDS" },
            { name: "days", label: "Days", type: "number", required: true, defaultValue: 5 }, { name: "qty", label: "Quantity", type: "number", required: true, defaultValue: 15 },
            { name: "instructions", label: "Patient instructions" }, { name: "sub", label: "Allow substitution", type: "checkbox" },
          ]} />
          <p className="mt-2 text-xs text-muted">Controlled medicines cannot be prescribed here. Drug-interaction checking is not performed: no licensed knowledge source is connected.</p>
        </Card>
      )}
      <Card title={`Medicine catalogue (${meds.length})`}>
        <Table head={["Name", "Generic", "SKU", "Form", "Price"]} empty={meds.length ? undefined : "No medicines yet. Add them under Inventory."}>
          {meds.map((m) => <tr key={m._id}><td>{m.name}{m.controlled && <Badge tone="danger">controlled</Badge>}</td><td>{m.genericName}</td><td className="font-mono text-xs">{m.sku}</td><td>{[m.strength, m.form].filter(Boolean).join(" ")}</td><td>{m.sellingPrice ? aed(fromDecimal128(m.sellingPrice).toFixed(2)) : "—"}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}
