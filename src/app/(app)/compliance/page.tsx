import { requireCtx } from "@/lib/session";
import { Alert, Badge, Card, NoAccess, PageHeader, Stat, Table, Tabs } from "@/ui/kit";
import { ActionButton, ActionForm, fmtDate, fmtDateTime } from "@/ui/forms";
import {
  auditReport, complianceDashboard, expiringItems, integrationMatrix, listChecklist, listIncidents, listLicences, policyStatus, READINESS,
} from "@/modules/compliance/service";
import { interfaceMonitor, listHieMessages } from "@/modules/integrations/hie";
import { eInvoiceStatus } from "@/modules/integrations/einvoice";

const TABS = [{ key: "overview", label: "Overview" }, { key: "licences", label: "Licences" }, { key: "checklist", label: "Checklist" }, { key: "incidents", label: "Incidents" }, { key: "policies", label: "Policies" }, { key: "integrations", label: "Integration readiness" }, { key: "audit", label: "Audit" }];
const READY_TONE: Record<string, "neutral" | "info" | "ok" | "warn"> = { not_configured: "neutral", specification_reviewed: "info", adapter_implemented: "info", sandbox_tested: "warn", certification_pending: "warn", approved: "ok", production_connected: "ok" };

export default async function CompliancePage({ searchParams }: { searchParams: Promise<{ tab?: string; error?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  if (!ctx.permissions.includes("compliance:view")) return <NoAccess what="compliance" />;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "overview";
  const back = `/compliance?tab=${tab}`;
  const can = (p: string) => ctx.permissions.includes(p as never);

  return (
    <div className="space-y-4">
      <PageHeader title="Compliance" sub="Licences, checklists, incidents, policies and integration readiness. These are technical controls and records; they are not a regulatory certification." />
      {sp.error && <Alert>{sp.error}</Alert>}
      <Tabs tabs={TABS} active={tab} base="/compliance" />

      {tab === "overview" && <Overview ctx={ctx} />}
      {tab === "licences" && (
        <>
          <Card title="Licences and expiring documents"><Expiring ctx={ctx} /></Card>
          <Card title="Registered licences"><Licences ctx={ctx} /></Card>
          {can("compliance:create") && <Card title="Add licence"><ActionForm action="comp.licence" back={back} submit="Add" fields={[{ name: "kind", label: "Kind", type: "select", options: ["facility", "practitioner"] }, { name: "holder", label: "Holder", required: true }, { name: "authority", label: "Authority", type: "select", options: ["DHA", "DOH", "MOHAP", "DHCC", "OTHER"] }, { name: "number", label: "Number", required: true }, { name: "expiry", label: "Expiry", type: "date", required: true }]} /></Card>}
        </>
      )}
      {tab === "checklist" && <Checklist ctx={ctx} back={back} can={can} />}
      {tab === "incidents" && <Incidents ctx={ctx} back={back} can={can} />}
      {tab === "policies" && <Policies ctx={ctx} back={back} can={can} />}
      {tab === "integrations" && <Integrations ctx={ctx} back={back} can={can} />}
      {tab === "audit" && <Audit ctx={ctx} />}
    </div>
  );
}
type C = Awaited<ReturnType<typeof requireCtx>>;
type Can = (p: string) => boolean;

async function Overview({ ctx }: { ctx: C }) {
  const d = await complianceDashboard(ctx);
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="Expired documents" value={d.expired} tone={d.expired ? "danger" : undefined} /><Stat label="Expiring in 60 days" value={d.expiringSoon} tone={d.expiringSoon ? "warn" : undefined} /><Stat label="Checklist items open" value={d.checklistOpen} hint={`${d.checklistOverdue} overdue`} /><Stat label="Open incidents" value={d.incidentsOpen} tone={d.incidentsOpen ? "warn" : undefined} /><Stat label="Integrations in production" value={`${d.integrationsLive} / ${d.integrationsTotal}`} hint="None is live until approved and connected" /></div>;
}
async function Expiring({ ctx }: { ctx: C }) {
  const e = await expiringItems(ctx, 90);
  return <Table head={["Source", "Item", "Expiry", ""]} empty="Nothing expiring within 90 days.">{e.map((x, i) => <tr key={i}><td className="text-xs">{x.source}</td><td>{x.label}</td><td>{fmtDate(x.expiry)}</td><td>{x.expired ? <Badge tone="danger">expired</Badge> : <Badge tone="warn">expiring</Badge>}</td></tr>)}</Table>;
}
async function Licences({ ctx }: { ctx: C }) {
  const l = await listLicences(ctx);
  return <Table head={["Kind", "Holder", "Authority", "Number", "Expiry"]} empty="None registered.">{l.map((x) => <tr key={x._id}><td className="capitalize">{x.kind}</td><td>{x.holder}</td><td>{x.authority}</td><td className="font-mono text-xs">{x.number}</td><td>{fmtDate(x.expiry)}</td></tr>)}</Table>;
}
async function Checklist({ ctx, back, can }: { ctx: C; back: string; can: Can }) {
  const rows = await listChecklist(ctx);
  return (
    <>
      <Card title="Regulatory checklist"><Table head={["Item", "Authority", "Due", "Evidence", "Status", ""]} empty={rows.length ? undefined : "No items."}>{rows.map((c) => <tr key={c._id}><td>{c.title}</td><td>{c.authority}</td><td>{fmtDate(c.dueDate)}</td><td>{c.evidenceIds.length}</td><td><Badge tone={c.status === "compliant" ? "ok" : c.status === "open" ? "warn" : "info"}>{c.status.replace("_", " ")}</Badge></td><td>{can("compliance:update") && c.status !== "compliant" && <ActionForm inline action="comp.checklistStatus" back={back} hidden={{ id: c._id }} submit="Update" variant="outline" fields={[{ name: "status", label: "Status", type: "select", options: ["in_progress", "compliant", "not_applicable"] }, { name: "evidenceId", label: "Evidence attachment ID" }]} />}</td></tr>)}</Table><p className="mt-2 text-xs text-muted">An item cannot be marked compliant without attached evidence.</p></Card>
      {can("compliance:create") && <Card title="Add checklist item"><ActionForm action="comp.checklist" back={back} submit="Add" fields={[{ name: "title", label: "Requirement", required: true, span: 2 }, { name: "authority", label: "Authority", required: true }, { name: "due", label: "Due", type: "date" }, { name: "owner", label: "Owner" }]} /></Card>}
    </>
  );
}
async function Incidents({ ctx, back, can }: { ctx: C; back: string; can: Can }) {
  const rows = await listIncidents(ctx);
  return (
    <>
      {rows.map((i) => <Card key={i._id} title={<span>{i.title} <Badge tone={i.severity === "critical" || i.severity === "high" ? "danger" : "warn"}>{i.severity}</Badge></span>} action={<Badge tone={i.status === "closed" ? "ok" : "info"}>{i.status}</Badge>}>
        <p className="text-sm">{i.description}</p>
        <ul className="mt-2 space-y-1 text-sm">{i.actions.map((a) => <li key={a._id} className="flex items-center gap-2">{a.done ? "✓" : "○"} {a.description} <span className="text-xs text-muted">({a.owner}, due {fmtDate(a.due)})</span>{!a.done && can("compliance:update") && <ActionButton action="comp.actionDone" back={back} hidden={{ incidentId: i._id, actionId: a._id }}>Done</ActionButton>}</li>)}</ul>
        {i.status !== "closed" && <div className="mt-3 grid gap-3 border-t border-border pt-3 lg:grid-cols-2">{can("compliance:update") && <ActionForm action="comp.action" back={back} hidden={{ incidentId: i._id }} submit="Add corrective action" variant="outline" fields={[{ name: "description", label: "Action", required: true }, { name: "owner", label: "Owner", required: true }, { name: "due", label: "Due", type: "date", required: true }]} />}{can("compliance:approve") && <ActionForm action="comp.incidentClose" back={back} hidden={{ id: i._id }} submit="Close incident" fields={[{ name: "note", label: "Closing note", required: true }]} />}</div>}
      </Card>)}
      {rows.length === 0 && <Card><p className="text-sm text-muted">No incidents recorded.</p></Card>}
      {can("compliance:create") && <Card title="Report an incident"><ActionForm action="comp.incident" back={back} submit="Report" fields={[{ name: "title", label: "Title", required: true }, { name: "severity", label: "Severity", type: "select", options: ["low", "medium", "high", "critical"] }, { name: "description", label: "What happened", type: "textarea", required: true, span: 3 }]} /></Card>}
    </>
  );
}
async function Policies({ ctx, back, can }: { ctx: C; back: string; can: Can }) {
  const rows = await policyStatus(ctx);
  return (
    <>
      <Card title="Policies"><Table head={["Policy", "Version", "Acknowledged by", ""]} empty={rows.length ? undefined : "No policies published."}>{rows.map((r) => <tr key={r.policy._id}><td><strong>{r.policy.title}</strong><div className="max-w-md text-xs text-muted">{r.policy.body.slice(0, 160)}</div></td><td>v{r.policy.version}</td><td>{r.acknowledgedBy} staff</td><td>{r.mine ? <Badge tone="ok">you acknowledged</Badge> : <ActionButton action="comp.ack" back={back} hidden={{ id: r.policy._id }} variant="primary">I have read this</ActionButton>}</td></tr>)}</Table></Card>
      {can("compliance:approve") && <div className="grid gap-4 lg:grid-cols-2"><Card title="Publish policy"><ActionForm action="comp.policy" back={back} submit="Publish" fields={[{ name: "title", label: "Title", required: true, span: 3 }, { name: "body", label: "Text", type: "textarea", required: true, span: 3 }]} /></Card><Card title="Access review"><ActionForm action="comp.accessReview" back={back} submit="Record attestation" fields={[{ name: "note", label: "I reviewed user roles and access…", type: "textarea", required: true, span: 3 }]} /></Card></div>}
    </>
  );
}
async function Integrations({ ctx, back, can }: { ctx: C; back: string; can: Can }) {
  const [m, mon, msgs, einv] = await Promise.all([integrationMatrix(ctx), can("integrations:view") ? interfaceMonitor(ctx) : null, can("integrations:view") ? listHieMessages(ctx) : [], can("billing:view") ? eInvoiceStatus(ctx) : []]);
  return (
    <>
      <Card title="Integration readiness matrix"><Table head={["Integration", "Status", "Evidence", ""]}>{m.map((r) => <tr key={r._id}><td>{r.name}</td><td><Badge tone={READY_TONE[r.status]}>{r.status.replaceAll("_", " ")}</Badge></td><td className="max-w-xs text-xs text-muted">{r.evidence}</td><td>{can("compliance:approve") && <ActionForm inline action="comp.integration" back={back} hidden={{ key: r.key }} submit="Set" variant="outline" fields={[{ name: "status", label: "New status", type: "select", defaultValue: r.status, options: READINESS.map((x) => ({ value: x, label: x.replaceAll("_", " ") })) }, { name: "evidence", label: "Evidence / reason" }]} />}</td></tr>)}</Table>
        <p className="mt-2 text-xs text-muted">Stages advance one at a time; &quot;approved&quot; and &quot;production connected&quot; need written evidence. No real government or payer connection exists in this build.</p></Card>
      {mon && (
        <Card title="Health-information-exchange queue (SANDBOX)" action={<span className="text-xs text-muted">pending {mon.pending} · acknowledged {mon.acknowledged} · error queue {mon.errorQueue}</span>}>
          <div className="mb-2 flex gap-2">{can("integrations:update") && <ActionButton action="hie.process" back={back}>Process queue</ActionButton>}</div>
          <Table head={["When", "Exchange", "Type", "Status", "Attempts"]} empty="No messages queued.">{msgs.map((x) => <tr key={x._id}><td className="text-xs">{fmtDateTime(x.createdAt)}</td><td>{x.hie}</td><td>{x.type}</td><td><Badge tone={x.status === "acknowledged" ? "ok" : x.status === "dead" ? "danger" : "warn"}>{x.status}</Badge></td><td>{x.attempts}{x.status === "dead" && can("integrations:update") && <ActionButton action="hie.retryDead" back={back} hidden={{ id: x._id }}>Retry</ActionButton>}</td></tr>)}</Table>
        </Card>
      )}
      {einv.length > 0 && <Card title="Structured e-invoice submissions (SANDBOX service provider)"><Table head={["Document", "Version", "Status", "Errors"]}>{einv.map((x) => <tr key={x._id}><td>{x.number}</td><td>v{x.version}</td><td><Badge tone={x.status === "accepted" ? "ok" : "danger"}>{x.status}</Badge></td><td className="text-xs text-danger">{x.errors.join("; ")}</td></tr>)}</Table></Card>}
    </>
  );
}
async function Audit({ ctx }: { ctx: C }) {
  if (!ctx.permissions.includes("audit:audit")) return <Card><p className="text-sm text-muted">The audit report needs audit access.</p></Card>;
  const r = await auditReport(ctx, { from: new Date(Date.now() - 30 * 86400000), to: new Date(Date.now() + 86400000) });
  return <div className="grid gap-4 lg:grid-cols-2"><Card title={`Actions, last 30 days (${r.total})`}><Table head={["Action", "Count"]}>{r.byAction.slice(0, 30).map((a) => <tr key={a.action}><td className="font-mono text-xs">{a.action}</td><td>{a.count}</td></tr>)}</Table></Card><Card title="By user"><Table head={["User", "Actions"]}>{r.byActor.map((a) => <tr key={a.actorId}><td className="font-mono text-xs">{a.actorId}</td><td>{a.count}</td></tr>)}</Table></Card></div>;
}
