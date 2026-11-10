import Link from "next/link";
import { requireCtx } from "@/lib/session";
import { fromDecimal128 } from "@/core/money";
import { getPatient, patientNames } from "@/modules/patients/service";
import { listUnbilledCharges } from "@/modules/billing/charges";
import { listOpenInvoices } from "@/modules/billing/invoice";
import { Alert, Badge, Button, Card, NoAccess, PageHeader, Table, aed } from "@/ui/kit";
import { PatientPicker } from "../appointments/PatientPicker";
import { finalizeAction } from "./actions";

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ patientId?: string; error?: string }> }) {
  const ctx = await requireCtx();
  const { patientId, error } = await searchParams;
  if (!ctx.permissions.includes("billing:view")) return <NoAccess what="billing" />;
  const patient = patientId ? await getPatient(ctx, patientId).catch(() => null) : null;
  const unbilled = patient ? await listUnbilledCharges(ctx, patient._id) : [];
  const open = await listOpenInvoices(ctx);
  const names = await patientNames(ctx, open.map((i) => i.patientId));

  return (
    <div className="space-y-4">
      <PageHeader title="Billing" sub="Charges become invoices; invoices are settled by payments" />
      {error && <Alert>{error}</Alert>}
      <Card title="Find patient's unbilled charges">
        <form className="flex gap-2"><div className="flex-1"><PatientPicker initial={patient ? { id: patient._id, label: `${patient.fullName} (${patient.mrn})` } : undefined} /></div><Button variant="outline">Load</Button></form>
      </Card>

      {patient && (
        <Card title={`Unbilled charges — ${patient.fullName}`}>
          {unbilled.length === 0 ? <p className="text-sm text-muted">Nothing to bill. Charges appear when a consultation is completed or services are added to an encounter.</p> : (
            <form action={finalizeAction} className="space-y-3">
              <input type="hidden" name="patientId" value={patient._id} />
              <Table head={["", "Service", "Qty", "Unit price", "VAT %"]}>
                {unbilled.map((c) => (
                  <tr key={c._id}>
                    <td><input type="checkbox" name="chargeId" value={c._id} defaultChecked aria-label={`Include ${c.name}`} /></td>
                    <td>{c.name}</td><td>{c.qty}</td><td className="tabular-nums">{aed(fromDecimal128(c.unitPrice).toFixed(2))}</td><td>{fromDecimal128(c.taxRate).toFixed(0)}%</td>
                  </tr>
                ))}
              </Table>
              {ctx.permissions.includes("billing:create") && <Button>Finalize invoice</Button>}
            </form>
          )}
        </Card>
      )}

      <Card title={`Open invoices (${open.length})`}>
        <Table head={["Invoice", "Patient", "Total", "Balance", "Status"]} empty={open.length ? undefined : "No open invoices."}>
          {open.map((i) => (
            <tr key={i._id}>
              <td><Link className="text-primary hover:underline" href={`/billing/invoices/${i._id}`}>{i.number}</Link></td>
              <td>{names.get(i.patientId)?.fullName ?? "—"}</td>
              <td className="tabular-nums">{aed(fromDecimal128(i.total).toFixed(2))}</td>
              <td className="tabular-nums">{aed(fromDecimal128(i.balance).toFixed(2))}</td>
              <td><Badge tone="warn">{i.status.replace("_", " ")}</Badge></td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
