import Link from "next/link";
import { requireCtx } from "@/lib/session";
import { getWorkspace } from "@/modules/emr/service";
import { listEncounterCharges, listServices } from "@/modules/billing/charges";
import { fromDecimal128 } from "@/core/money";
import { Alert, Badge, Button, Card, Field, Input, NoAccess, PageHeader, Select, Table, Textarea, aed } from "@/ui/kit";
import { amendAction, chargeAction, completeAction, diagnosisAction, noteAction, vitalsAction } from "./actions";

const fmt = (d: Date) => new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" });

export default async function EncounterPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const { error } = await searchParams;
  if (!ctx.permissions.includes("emr:view")) return <NoAccess what="clinical records" />;
  const w = await getWorkspace(ctx, id);
  const can = (p: string) => ctx.permissions.includes(p as never);
  const services = await listServices(ctx);
  const charges = await listEncounterCharges(ctx, id);
  const e = w.encounter;
  const note = w.note;
  const open = e.status === "open";
  const signed = note?.status === "signed";

  return (
    <div className="space-y-4">
      <PageHeader
        title={<>{w.patient.fullName} <span className="ms-2 font-mono text-sm text-muted">{w.patient.mrn}</span></>}
        sub={`Encounter opened ${fmt(e.openedAt)} · `}
        actions={<><Badge tone={open ? "info" : "ok"}>{e.status}</Badge><Link className="text-sm text-primary hover:underline" href={`/patients/${w.patient._id}`}>Patient record</Link></>}
      />
      {error && <Alert>{error}</Alert>}
      {(w.alerts.allergies.length > 0 || w.alerts.medical.length > 0) && (
        <Alert tone="danger">
          <strong>Safety alerts:</strong>{" "}
          {w.alerts.allergies.map((a, i) => <span key={i} className="me-2">Allergy — {a.substance}{a.reaction ? ` (${a.reaction})` : ""}{a.severity ? `, ${a.severity}` : ""};</span>)}
          {w.alerts.medical.map((a, i) => <span key={i} className="me-2">{a};</span>)}
        </Alert>
      )}
      {w.warnings.length > 0 && open && <Alert tone="warn">{w.warnings.join(" · ")}</Alert>}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title={`Clinical note — version ${note?.version ?? 1}`} action={<Badge tone={signed ? "ok" : "warn"}>{note?.status}</Badge>}>
            {note && !signed && open && can("emr:update") ? (
              <form action={noteAction} className="space-y-3">
                <input type="hidden" name="encounterId" value={e._id} /><input type="hidden" name="noteId" value={note._id} />
                {(["s", "o", "a", "p"] as const).map((k) => (
                  <Field key={k} label={{ s: "Subjective", o: "Objective", a: "Assessment", p: "Plan" }[k]}><Textarea name={k} defaultValue={note.soap[k]} /></Field>
                ))}
                <div className="flex gap-2">
                  <Button name="intent" value="save" variant="outline">Save draft</Button>
                  {can("emr:approve") && <Button name="intent" value="sign">Sign note</Button>}
                </div>
              </form>
            ) : note ? (
              <div className="space-y-3 text-sm">
                {(["s", "o", "a", "p"] as const).map((k) => <div key={k}><div className="text-xs font-medium text-muted">{{ s: "Subjective", o: "Objective", a: "Assessment", p: "Plan" }[k]}</div><p className="whitespace-pre-wrap">{note.soap[k] || "—"}</p></div>)}
                <p className="text-xs text-muted">Signed {note.signedAt ? fmt(note.signedAt) : ""}{note.amendReason ? ` · amended: ${note.amendReason}` : ""}</p>
                {signed && can("emr:approve") && (
                  <details className="rounded-ui border border-border p-3">
                    <summary className="cursor-pointer text-sm font-medium">Amend this note (creates a new signed version)</summary>
                    <form action={amendAction} className="mt-3 space-y-3">
                      <input type="hidden" name="encounterId" value={e._id} /><input type="hidden" name="noteId" value={note._id} />
                      {(["s", "o", "a", "p"] as const).map((k) => <Field key={k} label={{ s: "Subjective", o: "Objective", a: "Assessment", p: "Plan" }[k]}><Textarea name={k} defaultValue={note.soap[k]} /></Field>)}
                      <Field label="Reason for amendment *"><Input name="reason" required /></Field>
                      <Button variant="outline">Sign amendment</Button>
                    </form>
                  </details>
                )}
              </div>
            ) : null}
            {w.versions.length > 1 && (
              <div className="mt-4 border-t border-border pt-3"><div className="mb-1 text-xs font-medium text-muted">Version history</div>
                <ul className="space-y-1 text-xs text-muted">{w.versions.map((v) => <li key={v._id}>v{v.version} — {v.status}{v.signedAt ? ` · ${fmt(v.signedAt)}` : ""}{v.amendReason ? ` · ${v.amendReason}` : ""}</li>)}</ul></div>
            )}
          </Card>

          <Card title="Diagnoses">
            <Table head={["Code", "Description", ""]} empty={e.diagnoses.length ? undefined : "No diagnoses recorded."}>
              {e.diagnoses.map((d, i) => <tr key={i}><td className="font-mono text-xs">{d.code}</td><td>{d.description}</td><td>{d.primary && <Badge tone="info">Primary</Badge>}</td></tr>)}
            </Table>
            {open && can("emr:update") && (
              <form action={diagnosisAction} className="mt-3 grid gap-2 sm:grid-cols-5">
                <input type="hidden" name="encounterId" value={e._id} />
                <Field label="ICD-10-CM code"><Input name="code" required placeholder="J06.9" /></Field>
                <div className="sm:col-span-2"><Field label="Description"><Input name="description" required /></Field></div>
                <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" name="primary" /> Primary</label>
                <div className="flex items-end"><Button variant="outline" className="w-full">Add</Button></div>
              </form>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Vital signs">
            <ul className="mb-3 space-y-1 text-xs text-muted">
              {e.vitals.map((v, i) => <li key={i}>{fmt(v.at)} — {v.systolic && `BP ${v.systolic}/${v.diastolic ?? "?"} `}{v.heartRate && `HR ${v.heartRate} `}{v.tempC && `T ${v.tempC}°C `}{v.spo2 && `SpO₂ ${v.spo2}% `}{v.weightKg && `${v.weightKg} kg`}</li>)}
              {e.vitals.length === 0 && <li>None recorded.</li>}
            </ul>
            {open && can("emr:update") && (
              <form action={vitalsAction} className="grid grid-cols-2 gap-2">
                <input type="hidden" name="encounterId" value={e._id} />
                <Field label="Systolic"><Input name="systolic" type="number" /></Field><Field label="Diastolic"><Input name="diastolic" type="number" /></Field>
                <Field label="Heart rate"><Input name="heartRate" type="number" /></Field><Field label="Temp °C"><Input name="tempC" type="number" step="0.1" /></Field>
                <Field label="SpO₂ %"><Input name="spo2" type="number" /></Field><Field label="Weight kg"><Input name="weightKg" type="number" step="0.1" /></Field>
                <Button variant="outline" className="col-span-2">Record vitals</Button>
              </form>
            )}
          </Card>

          <Card title="Billable services">
            <ul className="mb-3 space-y-1 text-sm">
              {charges.map((c) => <li key={c._id} className="flex justify-between"><span>{c.name} × {c.qty}</span><span className="tabular-nums">{aed(fromDecimal128(c.unitPrice).times(c.qty).toFixed(2))}</span></li>)}
              {charges.length === 0 && <li className="text-muted">Added when the encounter is completed, or manually below.</li>}
            </ul>
            {open && (can("billing:create") || can("emr:update")) && (
              <form action={chargeAction} className="flex gap-2">
                <input type="hidden" name="encounterId" value={e._id} />
                <Select name="serviceId" aria-label="Service">{services.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}</Select>
                <Input name="qty" type="number" min={1} defaultValue={1} className="w-16" aria-label="Quantity" />
                <Button variant="outline">Add</Button>
              </form>
            )}
          </Card>

          {open && can("emr:update") && (
            <form action={completeAction}>
              <input type="hidden" name="encounterId" value={e._id} />
              <Button className="w-full" disabled={!signed} title={signed ? "" : "Sign the note first"}>Complete encounter</Button>
              {!signed && <p className="mt-1 text-xs text-muted">Sign the clinical note to complete the encounter.</p>}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
