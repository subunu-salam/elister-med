import Link from "next/link";
import { requireCtx } from "@/lib/session";
import { Alert, Badge, Card, NoAccess, PageHeader, Stat, Table, Tabs } from "@/ui/kit";
import { ActionButton, ActionForm, fmtDateTime } from "@/ui/forms";
import { labDashboard, listOpenCritical, listTests, workQueue } from "@/modules/laboratory/service";
import { patientNames } from "@/modules/patients/service";

const TABS = [{ key: "queue", label: "Work queue" }, { key: "critical", label: "Critical alerts" }, { key: "tests", label: "Test catalogue" }];
const FLAG: Record<string, "ok" | "warn" | "danger" | "neutral"> = { normal: "ok", low: "warn", high: "warn", critical_low: "danger", critical_high: "danger", range_unreviewed: "neutral", no_range: "neutral" };

export default async function LabPage({ searchParams }: { searchParams: Promise<{ tab?: string; error?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  if (!ctx.permissions.includes("laboratory:view")) return <NoAccess what="the laboratory" />;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "queue";
  const back = `/laboratory?tab=${tab}`;
  const can = (p: string) => ctx.permissions.includes(p as never);
  const staff = can("laboratory:update");
  const [dash, tests, critical, queue] = await Promise.all([labDashboard(ctx), listTests(ctx), listOpenCritical(ctx), staff ? workQueue(ctx) : Promise.resolve([])]);
  const names = await patientNames(ctx, queue.map((o) => o.patientId));

  return (
    <div className="space-y-4">
      <PageHeader title="Laboratory" sub="Order → collect → process → result → verify (second person) → release" />
      {sp.error && <Alert>{sp.error}</Alert>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6"><Stat label="To collect" value={dash.awaitingCollection} /><Stat label="In processing" value={dash.inProcessing} /><Stat label="To verify" value={dash.awaitingVerification} /><Stat label="Ready to release" value={dash.verifiedNotReleased} /><Stat label="Critical alerts" value={dash.openCriticalAlerts} tone={dash.openCriticalAlerts ? "danger" : undefined} /><Stat label="Avg turnaround (min)" value={dash.avgTurnaroundMinutes.toFixed(0)} /></div>
      <Tabs tabs={TABS} active={tab} base="/laboratory" />

      {tab === "queue" && (staff ? (
        <div className="space-y-3">
          {queue.length === 0 && <Card><p className="text-sm text-muted">No open orders.</p></Card>}
          {queue.map((o) => (
            <Card key={o._id} title={<span><span className="font-mono">{o.number}</span> · {names.get(o.patientId)?.fullName} {o.priority !== "routine" && <Badge tone="danger">{o.priority}</Badge>}</span>} action={<Badge tone="info">{o.status}</Badge>}>
              <p className="mb-2 text-xs text-muted">{o.barcode ? `Barcode ${o.barcode} · ` : ""}Ordered {fmtDateTime(o.orderedAt)}{o.externalLab ? ` · external: ${o.externalLab}` : ""}</p>
              <Table head={["Test", "Result", "Flag"]}>{o.tests.map((t) => <tr key={t.testId}><td>{t.name}</td><td>{t.value !== undefined ? `${t.value} ${t.unit}` : o.status === "processing" || o.status === "resulted" ? <ActionForm inline action="lab.result" back={back} hidden={{ orderId: o._id, testId: t.testId }} submit="Save" variant="outline" fields={[{ name: "value", label: t.unit, type: "number", step: "any", required: true }]} /> : "—"}</td><td>{t.flag && <Badge tone={FLAG[t.flag]}>{t.flag.replace("_", " ")}</Badge>}</td></tr>)}</Table>
              <div className="mt-2 flex flex-wrap gap-2">
                {o.status === "ordered" && <ActionButton action="lab.collect" back={back} hidden={{ id: o._id }}>Collect sample</ActionButton>}
                {o.status === "collected" && <ActionButton action="lab.receive" back={back} hidden={{ id: o._id }}>Receive in lab</ActionButton>}
                {o.status === "received" && <ActionButton action="lab.process" back={back} hidden={{ id: o._id }}>Start processing</ActionButton>}
                {o.status === "resulted" && can("laboratory:approve") && <ActionButton action="lab.verify" back={back} hidden={{ id: o._id }} variant="primary">Verify results</ActionButton>}
                {o.status === "verified" && can("laboratory:approve") && <ActionButton action="lab.release" back={back} hidden={{ id: o._id }} variant="primary">Release</ActionButton>}
                <Link className="text-sm text-primary hover:underline" href={`/laboratory/${o._id}`}>Open report</Link>
              </div>
            </Card>
          ))}
        </div>
      ) : <Card><p className="text-sm text-muted">Doctors see results here once the laboratory releases them. Open an order from the patient record.</p></Card>)}

      {tab === "critical" && (
        <Card title="Open critical results">
          <Table head={["Test", "Value", "Flag", "When", ""]} empty={critical.length ? undefined : "No open critical alerts."}>
            {critical.map((a) => <tr key={a._id}><td>{a.testName}</td><td className="font-semibold text-danger">{a.value}</td><td><Badge tone="danger">{a.flag.replace("_", " ")}</Badge></td><td className="text-xs">{fmtDateTime(a.at)}</td><td>{can("emr:update") && <ActionForm inline action="lab.ack" back={back} hidden={{ id: a._id }} submit="Acknowledge" variant="outline" fields={[{ name: "note", label: "Action taken", required: true }]} />}</td></tr>)}
          </Table>
          <p className="mt-2 text-xs text-muted">A result with an open critical alert cannot be released until the clinician documents how it was acted on.</p>
        </Card>
      )}

      {tab === "tests" && (
        <>
          <Card title="Tests">
            <Table head={["Code", "Name", "Specimen", "Unit", "Ranges"]} empty={tests.length ? undefined : "No tests configured."}>
              {tests.map((t) => <tr key={t._id}><td className="font-mono text-xs">{t.code}</td><td>{t.name}{t.loinc && <span className="ms-1 text-xs text-muted">LOINC {t.loinc}</span>}</td><td>{t.specimen}</td><td>{t.unit}</td>
                <td>{t.rangesApprovedBy ? <Badge tone="ok">approved</Badge> : <span className="flex items-center gap-2"><Badge tone="warn">not approved</Badge>{can("laboratory:approve") && <ActionButton action="lab.approveRanges" back={back} hidden={{ id: t._id }}>Approve</ActionButton>}</span>}</td></tr>)}
            </Table>
            <p className="mt-2 text-xs text-muted">Reference ranges are laboratory configuration. There are no defaults, and results are not flagged until a range set is approved.</p>
          </Card>
          {can("laboratory:create") && <Card title="Add test"><ActionForm action="lab.test" back={back} submit="Add test" fields={[{ name: "code", label: "Code", required: true }, { name: "name", label: "Name", required: true }, { name: "loinc", label: "LOINC (optional)" }, { name: "specimen", label: "Specimen", required: true }, { name: "unit", label: "Unit", required: true }, { name: "serviceId", label: "Billing service ID" }, { name: "sex", label: "Range applies to", type: "select", options: [{ value: "", label: "Any sex" }, { value: "male", label: "Male" }, { value: "female", label: "Female" }] }, { name: "low", label: "Low", type: "number", step: "any", required: true }, { name: "high", label: "High", type: "number", step: "any", required: true }, { name: "critLow", label: "Critical low", type: "number", step: "any" }, { name: "critHigh", label: "Critical high", type: "number", step: "any" }]} /></Card>}
        </>
      )}
    </div>
  );
}
