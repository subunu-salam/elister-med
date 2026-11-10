import { requireCtx } from "@/lib/session";
import { tenantCol } from "@/core/db";
import { Alert, Badge, Card, NoAccess, PageHeader, Stat, Table, Tabs, cn } from "@/ui/kit";
import { ActionButton, ActionForm, fmtDateTime } from "@/ui/forms";
import { bedBoard, erEscalations, erQueue, hospitalDashboard, listAdmissions, listMar, listSurgeries } from "@/modules/hospital/service";
import { patientNames } from "@/modules/patients/service";
import { listDoctors } from "@/modules/appointments/service";

const TABS = [{ key: "beds", label: "Bed board" }, { key: "admissions", label: "Inpatients" }, { key: "er", label: "Emergency" }, { key: "theatre", label: "Theatre" }, { key: "setup", label: "Setup" }];
const BED_TONE: Record<string, string> = { free: "border-ok/40 bg-ok/10", occupied: "border-danger/40 bg-danger/10", cleaning: "border-warn/40 bg-warn/10", blocked: "border-border bg-surface-2" };

export default async function HospitalPage({ searchParams }: { searchParams: Promise<{ tab?: string; error?: string; adm?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  if (!ctx.permissions.includes("hospital:view")) return <NoAccess what="hospital modules" />;
  const org = await tenantCol<{ modules?: { hospital?: boolean } }>(ctx.orgId, "orgs").findOne({ _id: ctx.orgId } as never);
  if (!org?.modules?.hospital) return <div className="space-y-3"><PageHeader title="Hospital modules" /><Alert tone="warn">Inpatient, emergency and theatre modules are switched off for this organisation. They are optional add-ons for facilities that run those services, and are off by default for outpatient clinics.</Alert></div>;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "beds";
  const back = `/hospital?tab=${tab}`;
  const can = (p: string) => ctx.permissions.includes(p as never);
  const dash = await hospitalDashboard(ctx);

  return (
    <div className="space-y-4">
      <PageHeader title="Hospital" sub="Beds, inpatients, emergency and operating theatre. Clinical triage rules and escalation thresholds must be validated by qualified staff." />
      {sp.error && <Alert>{sp.error}</Alert>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5"><Stat label="Beds" value={dash.beds} /><Stat label="Occupied" value={dash.occupied} /><Stat label="Awaiting cleaning" value={dash.cleaning} /><Stat label="Inpatients" value={dash.admitted} /><Stat label="ER waiting" value={dash.erWaiting} tone={dash.erWaiting ? "warn" : undefined} /></div>
      <Tabs tabs={TABS} active={tab} base="/hospital" />
      {tab === "beds" && <Beds ctx={ctx} back={back} can={can} />}
      {tab === "admissions" && <Admissions ctx={ctx} back={back} can={can} adm={sp.adm} />}
      {tab === "er" && <Er ctx={ctx} back={back} can={can} />}
      {tab === "theatre" && <Theatre ctx={ctx} back={back} can={can} />}
      {tab === "setup" && <Setup back={back} can={can} />}
    </div>
  );
}
type C = Awaited<ReturnType<typeof requireCtx>>;
type Can = (p: string) => boolean;

async function Beds({ ctx, back, can }: { ctx: C; back: string; can: Can }) {
  const board = await bedBoard(ctx);
  return (
    <>
      {board.map((w) => <Card key={w._id} title={`${w.name} (${Math.round(w.occupancy * 100)}% occupied)`}><div className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-8">{w.beds.map((b) => <div key={b._id} className={cn("rounded-ui border p-2 text-center text-xs", BED_TONE[b.status])}><div className="font-semibold">{b.bedNo}</div><div className="capitalize text-muted">{b.status}</div>{b.status === "cleaning" && can("hospital:update") && <ActionButton action="hosp.clean" back={back} hidden={{ bedId: b._id }} className="mt-1">Clean</ActionButton>}</div>)}{w.beds.length === 0 && <p className="col-span-full text-sm text-muted">No beds yet.</p>}</div></Card>)}
      {board.length === 0 && <Card><p className="text-sm text-muted">No wards configured.</p></Card>}
      {can("hospital:create") && <div className="grid gap-4 lg:grid-cols-2"><Card title="Add ward"><ActionForm action="hosp.ward" back={back} submit="Add" fields={[{ name: "code", label: "Code", required: true }, { name: "name", label: "Name", required: true }]} /></Card>{board.length > 0 && <Card title="Add bed"><ActionForm action="hosp.bed" back={back} submit="Add" fields={[{ name: "wardId", label: "Ward", type: "select", options: board.map((w) => ({ value: w._id, label: w.name })) }, { name: "bedNo", label: "Bed number", required: true }]} /></Card>}</div>}
    </>
  );
}

async function Admissions({ ctx, back, can, adm }: { ctx: C; back: string; can: Can; adm?: string }) {
  const [rows, board, docs] = await Promise.all([listAdmissions(ctx), bedBoard(ctx), listDoctors(ctx).catch(() => [])]);
  const names = await patientNames(ctx, rows.map((r) => r.patientId));
  const freeBeds = board.flatMap((w) => w.beds.filter((b) => b.status === "free").map((b) => ({ value: b._id, label: `${w.name} · ${b.bedNo}` })));
  const sel = rows.find((r) => r._id === adm);
  const mar = sel ? await listMar(ctx, sel._id) : [];
  return (
    <>
      <Card title="Current inpatients"><Table head={["No.", "Patient", "Reason", "Admitted", ""]} empty="No inpatients.">{rows.map((a) => <tr key={a._id}><td className="font-mono text-xs">{a.number}</td><td>{names.get(a.patientId)?.fullName}</td><td className="text-xs">{a.reason}</td><td className="text-xs">{fmtDateTime(a.admittedAt)}</td><td><a className="text-xs text-primary hover:underline" href={`/hospital?tab=admissions&adm=${a._id}`}>Chart</a></td></tr>)}</Table></Card>
      {sel && (
        <Card title={`Chart: ${names.get(sel.patientId)?.fullName} (${sel.number})`}>
          <Table head={["Medication", "Dose", "Due", "Status", ""]} empty="No medication orders.">{mar.map((d) => <tr key={d._id}><td>{d.name}</td><td>{d.dose} {d.route}</td><td className="text-xs">{fmtDateTime(d.scheduledAt)}</td><td><Badge tone={d.status === "given" ? "ok" : d.status === "scheduled" ? "info" : "warn"}>{d.status}</Badge></td><td>{d.status === "scheduled" && can("hospital:update") && <div className="flex gap-1"><ActionButton action="hosp.dose" back={`${back}&adm=${sel._id}`} hidden={{ id: d._id, status: "given" }}>Given</ActionButton><ActionForm inline action="hosp.dose" back={`${back}&adm=${sel._id}`} hidden={{ id: d._id, status: "held" }} submit="Hold" variant="ghost" fields={[{ name: "reason", label: "Reason", required: true }]} /></div>}</td></tr>)}</Table>
          <div className="mt-3 grid gap-3 border-t border-border pt-3 lg:grid-cols-2">
            {can("hospital:update") && <ActionForm action="hosp.obs" back={`${back}&adm=${sel._id}`} hidden={{ admissionId: sel._id }} submit="Record observations" variant="outline" fields={[{ name: "systolic", label: "Systolic", type: "number" }, { name: "diastolic", label: "Diastolic", type: "number" }, { name: "hr", label: "Heart rate", type: "number" }, { name: "spo2", label: "SpO₂", type: "number" }, { name: "temp", label: "Temp °C", type: "number", step: "0.1" }, { name: "note", label: "Note" }]} />}
            {can("hospital:approve") && <ActionForm action="hosp.medOrder" back={`${back}&adm=${sel._id}`} hidden={{ admissionId: sel._id }} submit="Order medication" variant="outline" fields={[{ name: "itemId", label: "Medicine item ID", required: true }, { name: "dose", label: "Dose", required: true }, { name: "route", label: "Route", required: true, defaultValue: "PO" }, { name: "every", label: "Every (hours)", type: "number", required: true, defaultValue: 8 }, { name: "override", label: "Allergy override reason" }]} />}
            {can("hospital:approve") && <ActionForm action="hosp.discharge" back={back} hidden={{ admissionId: sel._id }} submit="Discharge" variant="danger" fields={[{ name: "summary", label: "Discharge summary", type: "textarea", required: true, span: 3 }, { name: "disposition", label: "Disposition", type: "select", options: ["home", "transfer", "against_advice", "deceased"] }]} />}
          </div>
        </Card>
      )}
      {can("hospital:create") && freeBeds.length > 0 && <Card title="Admit patient"><ActionForm action="hosp.admit" back={back} submit="Admit" fields={[{ name: "patientId", label: "Patient ID", required: true }, { name: "bedId", label: "Bed", type: "select", options: freeBeds }, { name: "doctorId", label: "Responsible doctor", type: "select", options: docs.map((d) => ({ value: d._id, label: d.name })) }, { name: "reason", label: "Reason for admission", required: true, span: 3 }]} /></Card>}
    </>
  );
}

async function Er({ ctx, back, can }: { ctx: C; back: string; can: Can }) {
  const [q, esc] = await Promise.all([erQueue(ctx), erEscalations(ctx)]);
  const names = await patientNames(ctx, q.map((v) => v.patientId).filter(Boolean) as string[]);
  const overdue = new Set(esc.map((e) => e.visitId));
  return (
    <>
      {esc.length > 0 && <Alert tone="danger">{esc.length} patient(s) waiting beyond the configured threshold for their triage level.</Alert>}
      <Card title="Emergency queue (most urgent first)"><Table head={["No.", "Patient", "Complaint", "Triage", "Waiting", ""]} empty="Nobody waiting.">{q.map((v) => <tr key={v._id} className={overdue.has(v._id) ? "bg-danger/5" : ""}><td className="font-mono text-xs">{v.number}</td><td>{v.patientId ? names.get(v.patientId)?.fullName : <em>{v.alias}</em>}</td><td className="text-xs">{v.complaint}</td><td>{v.triage ? <Badge tone={v.triage.level <= 2 ? "danger" : "info"}>Level {v.triage.level}</Badge> : <Badge tone="warn">untriaged</Badge>}</td><td className="text-xs">{Math.round((Date.now() - v.arrivalAt.getTime()) / 60000)} min</td>
        <td className="space-y-1">{!v.triage && can("hospital:update") && <ActionForm inline action="hosp.triage" back={back} hidden={{ id: v._id }} submit="Triage" variant="outline" fields={[{ name: "level", label: "Level 1-5", type: "number", required: true }, { name: "note", label: "Note" }]} />}{can("hospital:approve") && v.triage && <ActionForm inline action="hosp.erDispose" back={back} hidden={{ id: v._id }} submit="Disposition" variant="ghost" fields={[{ name: "type", label: "Outcome", type: "select", options: ["discharge", "transfer", "admit", "left_without_being_seen"] }, { name: "note", label: "Note", required: true }, { name: "facility", label: "Receiving facility" }, { name: "bedId", label: "Bed ID (admit)" }, { name: "doctorId", label: "Doctor ID (admit)" }]} />}</td></tr>)}</Table></Card>
      {can("hospital:create") && <Card title="Register ER arrival"><ActionForm action="hosp.erRegister" back={back} submit="Register" fields={[{ name: "patientId", label: "Patient ID (if known)" }, { name: "alias", label: "Temporary alias (unknown patient)" }, { name: "complaint", label: "Presenting complaint", required: true }, { name: "mode", label: "Arrival", type: "select", options: ["walk-in", "ambulance", "transfer"] }]} /><p className="mt-2 text-xs text-muted">The clinician chooses the triage level. No algorithm assigns it.</p></Card>}
    </>
  );
}

async function Theatre({ ctx, back, can }: { ctx: C; back: string; can: Can }) {
  const rows = await listSurgeries(ctx);
  const theatres = await tenantCol<{ _id: string; code: string; name: string }>(ctx.orgId, "theatres").find({} as never);
  const names = await patientNames(ctx, rows.map((r) => r.patientId));
  return (
    <>
      {rows.map((s) => (
        <Card key={s._id} title={<span><span className="font-mono">{s.number}</span> · {s.procedure} · {names.get(s.patientId)?.fullName}</span>} action={<Badge tone={s.status === "completed" ? "ok" : s.status === "cancelled" ? "danger" : "info"}>{s.status.replace("_", " ")}</Badge>}>
          <p className="text-xs text-muted">{fmtDateTime(s.start)} → {fmtDateTime(s.end)}</p>
          {s.status === "scheduled" && <ul className="mt-2 space-y-1 text-sm">{s.checklist.map((c, i) => <li key={i} className="flex items-center gap-2">{c.done ? "✓" : "○"} {c.item}{!c.done && can("hospital:update") && <ActionButton action="hosp.check" back={back} hidden={{ id: s._id, index: i }}>Done</ActionButton>}</li>)}</ul>}
          <div className="mt-2 flex flex-wrap gap-2">
            {s.status === "scheduled" && can("hospital:approve") && <><ActionButton action="hosp.consent" back={back} hidden={{ patientId: s.patientId }}>Record surgical consent</ActionButton><ActionButton action="hosp.start" back={back} hidden={{ id: s._id }} variant="primary">Start surgery</ActionButton></>}
            {s.status === "scheduled" && can("hospital:update") && <ActionForm inline action="hosp.cancel" back={back} hidden={{ id: s._id }} submit="Cancel" variant="ghost" fields={[{ name: "reason", label: "Reason", required: true }]} />}
            {s.status === "in_theatre" && can("hospital:update") && <ActionForm inline action="hosp.recovery" back={back} hidden={{ id: s._id }} submit="Move to recovery" variant="outline" fields={[{ name: "notes", label: "Procedure notes", required: true }]} />}
            {s.status === "recovery" && can("hospital:update") && <ActionForm inline action="hosp.recoveryObs" back={back} hidden={{ id: s._id }} submit="Add observation" variant="outline" fields={[{ name: "note", label: "Recovery observation", required: true }]} />}
            {s.status === "recovery" && can("hospital:approve") && <ActionButton action="hosp.complete" back={back} hidden={{ id: s._id }} variant="primary">Complete</ActionButton>}
          </div>
        </Card>
      ))}
      {rows.length === 0 && <Card><p className="text-sm text-muted">No surgeries scheduled.</p></Card>}
      {can("hospital:create") && <div className="grid gap-4 lg:grid-cols-2"><Card title="Add theatre"><ActionForm action="hosp.theatre" back={back} submit="Add" fields={[{ name: "code", label: "Code", required: true }, { name: "name", label: "Name", required: true }]} /></Card>{theatres.length > 0 && <Card title="Schedule surgery"><ActionForm action="hosp.surgery" back={back} submit="Schedule" fields={[{ name: "theatreId", label: "Theatre", type: "select", options: theatres.map((t) => ({ value: t._id, label: t.name })) }, { name: "patientId", label: "Patient ID", required: true }, { name: "procedure", label: "Procedure", required: true }, { name: "surgeonId", label: "Surgeon ID", required: true }, { name: "start", label: "Start", type: "datetime-local", required: true }, { name: "end", label: "End", type: "datetime-local", required: true }]} /></Card>}</div>}
      <p className="text-xs text-muted">A surgery cannot start until every checklist item is done and a granted surgical consent is on file. Nothing can bypass this.</p>
    </>
  );
}

function Setup({ back, can }: { back: string; can: Can }) {
  return can("hospital:approve") ? <Card title="Billing and escalation configuration"><ActionForm action="hosp.config" back={back} submit="Save" fields={[{ name: "bedServiceId", label: "Bed-day service ID" }, { name: "theatreServiceId", label: "Theatre fee service ID" }, ...[1, 2, 3, 4, 5].map((l) => ({ name: `th${l}`, label: `ER level ${l}: escalate after (min)`, type: "number" as const }))]} /><p className="mt-2 text-xs text-muted">Escalation thresholds are not defaulted: leave blank to disable. Values must be set by clinical leadership.</p></Card> : <Card><p className="text-sm text-muted">Approver access required.</p></Card>;
}
