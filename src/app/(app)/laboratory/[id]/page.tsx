import { requireCtx } from "@/lib/session";
import { Alert, Badge, NoAccess, Table } from "@/ui/kit";
import { fmtDateTime } from "@/ui/forms";
import { LogoAuto } from "@/ui/brand";
import { getOrder } from "@/modules/laboratory/service";
import { getPatient } from "@/modules/patients/service";
import { PrintButton } from "../../billing/receipts/[id]/PrintButton";

/** Printable lab report. Doctors see values only after release; laboratory staff see work in progress. */
export default async function LabReportPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  if (!ctx.permissions.includes("laboratory:view")) return <NoAccess what="laboratory reports" />;
  const o = await getOrder(ctx, id);
  const p = await getPatient(ctx, o.patientId);
  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <div className="no-print flex justify-end"><PrintButton /></div>
      {o.resultsHidden && <Alert tone="warn">Results are not released yet.</Alert>}
      <article className="rounded-ui border border-border bg-surface p-6 text-sm" aria-label="Laboratory report">
        <header className="mb-4 flex items-start justify-between border-b border-border pb-3"><div><LogoAuto className="mb-2 h-10" /><h1 className="text-lg font-semibold">Laboratory report</h1><p className="font-mono text-xs">{o.number}{o.barcode ? ` · ${o.barcode}` : ""}</p></div><Badge tone={o.status === "released" ? "ok" : "warn"}>{o.status}</Badge></header>
        <dl className="mb-4 grid grid-cols-2 gap-y-1"><dt className="text-muted">Patient</dt><dd>{p.fullName} ({p.mrn})</dd><dt className="text-muted">Date of birth / sex</dt><dd>{p.dob} / {p.sex}</dd><dt className="text-muted">Collected</dt><dd>{fmtDateTime(o.collectedAt)}</dd><dt className="text-muted">Released</dt><dd>{fmtDateTime(o.releasedAt)}</dd></dl>
        <Table head={["Test", "Result", "Unit", "Flag"]}>{o.tests.map((t) => <tr key={t.testId}><td>{t.name}</td><td className="font-semibold">{t.value ?? "—"}</td><td>{t.unit}</td><td>{t.flag ? t.flag.replace("_", " ") : ""}</td></tr>)}</Table>
        <p className="mt-4 text-xs text-muted">Flags use laboratory-approved reference ranges for the patient&apos;s sex and age. Interpretation is the responsibility of the treating clinician.</p>
      </article>
    </div>
  );
}
