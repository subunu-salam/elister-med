import { requireCtx } from "@/lib/session";
import { Alert, Badge, Card, NoAccess, PageHeader, Table } from "@/ui/kit";
import { ActionButton, ActionForm, fmtDateTime } from "@/ui/forms";
import { imagingWorklist } from "@/modules/radiology/service";
import { patientNames } from "@/modules/patients/service";

export default async function RadiologyPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireCtx();
  const { error } = await searchParams;
  if (!ctx.permissions.includes("radiology:view")) return <NoAccess what="radiology" />;
  const can = (p: string) => ctx.permissions.includes(p as never);
  const rows = can("radiology:update") ? await imagingWorklist(ctx) : [];
  const names = await patientNames(ctx, rows.map((r) => r.patientId));
  return (
    <div className="space-y-4">
      <PageHeader title="Radiology" sub="Orders, scheduling, reports and release. Image viewing and DICOM exchange are not built: link to your external PACS." />
      {error && <Alert>{error}</Alert>}
      <Card title="Worklist">
        <Table head={["Order", "Patient", "Study", "Status", "Scheduled", "Actions"]} empty={rows.length ? undefined : "No open imaging orders."}>
          {rows.map((r) => (
            <tr key={r._id}><td className="font-mono text-xs">{r.number}</td><td>{names.get(r.patientId)?.fullName}</td><td>{r.modality} · {r.study}</td><td><Badge tone="info">{r.status}</Badge></td><td className="text-xs">{fmtDateTime(r.scheduledAt)}</td>
              <td className="space-y-1">
                {["ordered", "scheduled"].includes(r.status) && <ActionForm inline action="rad.schedule" back="/radiology" hidden={{ id: r._id }} submit="Schedule" variant="outline" fields={[{ name: "when", label: "When", type: "datetime-local", required: true }]} />}
                {["ordered", "scheduled"].includes(r.status) && <ActionForm inline action="rad.perform" back="/radiology" hidden={{ id: r._id }} submit="Mark performed" variant="ghost" fields={[{ name: "pacsRef", label: "PACS reference" }]} />}
                {["performed", "reported"].includes(r.status) && can("radiology:create") && <ActionForm action="rad.report" back="/radiology" hidden={{ id: r._id }} submit="Save report" variant="outline" fields={[{ name: "findings", label: "Findings", type: "textarea", required: true, span: 3 }, { name: "impression", label: "Impression", type: "textarea", required: true, span: 3 }]} />}
                {r.status === "reported" && can("radiology:approve") && <ActionButton action="rad.release" back="/radiology" hidden={{ id: r._id }} variant="primary">Review and release</ActionButton>}
              </td></tr>
          ))}
        </Table>
        <p className="mt-2 text-xs text-muted">A different radiologist must review and release a report. Referring doctors see the report only after release.</p>
      </Card>
    </div>
  );
}
