import Link from "next/link";
import { requireCtx } from "@/lib/session";
import { fromDecimal128 } from "@/core/money";
import { Alert, Badge, Card, NoAccess, PageHeader, Table, Tabs, aed } from "@/ui/kit";
import { ActionButton, ActionForm, fmtDate, fmtDateTime } from "@/ui/forms";
import { listPayers, listPlans, listPreauths } from "@/modules/insurance/masters";
import { denialAnalysis, insuranceReceivables, listClaims } from "@/modules/insurance/claims";
import { patientNames } from "@/modules/patients/service";
import { EclaimTab } from "./EclaimTab";
import { Guide, PatientTab } from "./Workflow";

const TABS = [{ key: "guide", label: "Start here" }, { key: "claims", label: "Claims" }, { key: "setup", label: "Payers & plans" }, { key: "patient", label: "Insure a patient" }, { key: "preauth", label: "Pre-authorisation" }, { key: "recon", label: "Reconciliation" }, { key: "ecl", label: "DHA eClaimLink" }];
const TONE: Record<string, "neutral" | "ok" | "warn" | "danger" | "info"> = { draft: "neutral", validated: "info", submitted: "info", accepted: "ok", rejected: "danger", partially_paid: "warn", paid: "ok", written_off: "neutral" };

export default async function InsurancePage({ searchParams }: { searchParams: Promise<{ tab?: string; error?: string; notice?: string; patientId?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  if (!ctx.permissions.includes("insurance:view")) return <NoAccess what="insurance" />;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "guide";
  const back = `/insurance?tab=${tab}`;
  const can = (p: string) => ctx.permissions.includes(p as never);
  const payers = await listPayers(ctx), plans = await listPlans(ctx);
  const pname = new Map(payers.map((p) => [p._id, p.name]));

  return (
    <div className="space-y-4">
      <PageHeader title="Insurance" sub="Eligibility, pre-authorisation, claims and remittance. Submission uses the SANDBOX connector unless DHA eClaimLink (mock, test or production) is enabled on the eClaimLink tab." />
      {sp.error && <Alert>{sp.error}</Alert>}
      {sp.notice && <Alert tone="ok">{sp.notice}</Alert>}
      <Tabs tabs={TABS} active={tab} base="/insurance" />

      {tab === "guide" && <Guide ctx={ctx} />}
      {tab === "claims" && <Claims ctx={ctx} />}

      {tab === "setup" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Payers and TPAs">
            <Table head={["Name", "Code", "Kind"]} empty={payers.length ? undefined : "No payers yet."}>{payers.map((p) => <tr key={p._id}><td>{p.name}</td><td className="font-mono text-xs">{p.code}</td><td className="capitalize">{p.kind}</td></tr>)}</Table>
            {can("insurance:create") && <div className="mt-3 border-t border-border pt-3"><ActionForm action="ins.payer" back={back} submit="Add payer" fields={[{ name: "name", label: "Name", required: true }, { name: "code", label: "Code", required: true }, { name: "kind", label: "Kind", type: "select", options: ["insurer", "tpa"] }]} /></div>}
          </Card>
          <Card title="Plans">
            <Table head={["Plan", "Payer", "Co-pay", "Pre-auth for"]} empty={plans.length ? undefined : "No plans yet."}>{plans.map((p) => <tr key={p._id}><td>{p.name}</td><td>{pname.get(p.payerId)}</td><td>{p.copayPct}%{p.copayCapPerVisit ? ` (cap ${fromDecimal128(p.copayCapPerVisit).toFixed(2)})` : ""}</td><td className="text-xs">{p.preauthServiceCodes.join(", ") || "—"}</td></tr>)}</Table>
            {can("insurance:create") && payers.length > 0 && <div className="mt-3 border-t border-border pt-3"><ActionForm action="ins.plan" back={back} submit="Add plan" fields={[{ name: "payerId", label: "Payer", type: "select", options: payers.map((p) => ({ value: p._id, label: p.name })) }, { name: "name", label: "Plan name", required: true }, { name: "copayPct", label: "Co-pay %", type: "number", required: true, defaultValue: 20 }, { name: "cap", label: "Cap per visit (AED)" }, { name: "preauth", label: "Pre-auth service codes (comma separated)" }, { name: "exclusions", label: "Excluded service codes" }]} /></div>}
          </Card>
        </div>
      )}

      {tab === "patient" && <PatientTab ctx={ctx} patientId={sp.patientId} back={back} />}

      {tab === "preauth" && <Preauths ctx={ctx} back={back} />}

      {tab === "recon" && <Recon ctx={ctx} pname={pname} />}

      {tab === "ecl" && <EclaimTab ctx={ctx} back={back} />}
    </div>
  );
}

type C = Awaited<ReturnType<typeof requireCtx>>;

async function Claims({ ctx }: { ctx: C }) {
  const rows = await listClaims(ctx);
  const names = await patientNames(ctx, rows.map((r) => r.patientId));
  return (
    <Card title={`Claims (${rows.length})`}>
      <Table head={["Claim", "Patient", "Payer share", "Outstanding", "Status"]} empty={rows.length ? undefined : "No claims yet. Insure a visit to create one."}>
        {rows.map((c) => <tr key={c._id}><td><Link className="text-primary hover:underline" href={`/insurance/claims/${c._id}`}>{c.number}</Link></td><td>{names.get(c.patientId)?.fullName}</td><td className="tabular-nums">{aed(fromDecimal128(c.total).toFixed(2))}</td><td className="tabular-nums">{aed(fromDecimal128(c.outstanding).toFixed(2))}</td><td><Badge tone={TONE[c.status]}>{c.status.replace("_", " ")}</Badge></td></tr>)}
      </Table>
    </Card>
  );
}

async function Preauths({ ctx, back }: { ctx: C; back: string }) {
  const rows = await listPreauths(ctx);
  const names = await patientNames(ctx, rows.map((r) => r.patientId));
  return (
    <Card title="Pre-authorisations">
      <Table head={["Patient", "Services", "Estimate", "Status", ""]} empty={rows.length ? undefined : "None."}>
        {rows.map((p) => <tr key={p._id}><td>{names.get(p.patientId)?.fullName}</td><td className="text-xs">{p.serviceCodes.join(", ")}</td><td>{aed(fromDecimal128(p.estimatedAmount).toFixed(2))}</td><td><Badge tone={p.status === "approved" ? "ok" : p.status === "rejected" ? "danger" : "warn"}>{p.status}</Badge>{p.reference && <span className="ms-1 text-xs text-muted">{p.reference}</span>}</td>
          <td>{p.status === "requested" && ctx.permissions.includes("insurance:approve") && <><ActionButton action="ecl.preauthSend" back={back} hidden={{ id: p._id }} variant="ghost">Send to eClaimLink</ActionButton><ActionForm inline action="ins.preauthDecide" back={back} hidden={{ id: p._id }} submit="Decide" variant="outline" fields={[{ name: "decision", label: "Decision", type: "select", options: ["approve", "reject"] }, { name: "reference", label: "Payer ref." }]} /></>}</td></tr>)}
      </Table>
      <p className="mt-3 border-t border-border pt-3 text-xs text-muted">To request a new approval, open <a className="text-primary hover:underline" href="/insurance?tab=patient">Insure a patient</a>, load the patient and use step 3. The services and amount are filled in for you.</p>
    </Card>
  );
}

async function Recon({ ctx, pname }: { ctx: C; pname: Map<string, string> }) {
  const r = await insuranceReceivables(ctx);
  const d = await denialAnalysis(ctx);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Outstanding by payer (must equal the ledger)">
        <Table head={["Payer", "Outstanding"]} empty={r.byPayer.length ? undefined : "Nothing outstanding."}>{r.byPayer.map((x) => <tr key={x.payerId}><td>{pname.get(x.payerId) ?? x.payerId}</td><td className="tabular-nums">{aed(x.amount.toFixed(2))}</td></tr>)}<tr className="font-semibold"><td>Total</td><td className="tabular-nums">{aed(r.total.toFixed(2))}</td></tr></Table>
        <p className="mt-2 text-xs text-muted">Aging: {Object.entries(r.aging).map(([k, v]) => `${k}d ${aed(v.toFixed(2))}`).join(" · ")}</p>
      </Card>
      <Card title="Denial reasons"><Table head={["Reason", "Count"]} empty={d.length ? undefined : "No denials recorded."}>{d.map((x) => <tr key={x.reason}><td>{x.reason}</td><td>{x.count}</td></tr>)}</Table></Card>
    </div>
  );
}
void ActionButton; void fmtDateTime;
