import { requireCtx } from "@/lib/session";
import { fromDecimal128 } from "@/core/money";
import { Alert, Badge, Card, NoAccess, PageHeader, Table, Tabs, aed } from "@/ui/kit";
import { ActionButton, ActionForm, fmtDate } from "@/ui/forms";
import { documentExpiryAlerts, listEmployees, listLeave, listPayrollRuns } from "@/modules/hr/service";

const TABS = [{ key: "employees", label: "Employees" }, { key: "expiry", label: "Document expiry" }, { key: "leave", label: "Leave" }, { key: "payroll", label: "Payroll" }, { key: "policy", label: "Policy" }];

export default async function HrPage({ searchParams }: { searchParams: Promise<{ tab?: string; error?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  if (!ctx.permissions.includes("hr:view")) return <NoAccess what="HR" />;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "employees";
  const back = `/hr?tab=${tab}`;
  const can = (p: string) => ctx.permissions.includes(p as never);
  const emps = await listEmployees(ctx);
  const name = new Map(emps.map((e) => [e._id, e.name]));

  return (
    <div className="space-y-4">
      <PageHeader title="HR and staff" sub="Employees, licences and documents, attendance, leave and payroll preparation" />
      {sp.error && <Alert>{sp.error}</Alert>}
      <Tabs tabs={TABS} active={tab} base="/hr" />

      {tab === "employees" && (
        <>
          <Card title={`Employees (${emps.length})`}>
            <Table head={["No.", "Name", "Role", "Licence", "Basic", "Attendance"]} empty={emps.length ? undefined : "No employees yet."}>
              {emps.map((e) => <tr key={e._id}><td className="font-mono text-xs">{e.empNo}</td><td>{e.name}</td><td className="capitalize">{e.role}</td><td className="text-xs">{e.licence ? `${e.licence.authority} ${e.licence.number} → ${fmtDate(e.licence.expiry)}` : "—"}</td><td className="tabular-nums">{aed(fromDecimal128(e.contract.basic).toFixed(2))}</td>
                <td className="flex gap-1">{can("hr:create") && <><ActionButton action="hr.clockIn" back={back} hidden={{ employeeId: e._id }}>In</ActionButton><ActionButton action="hr.clockOut" back={back} hidden={{ employeeId: e._id }}>Out</ActionButton></>}</td></tr>)}
            </Table>
          </Card>
          {can("hr:create") && <Card title="Add employee"><ActionForm action="hr.employee" back={back} submit="Add employee" fields={[
            { name: "name", label: "Name", required: true }, { name: "nameAr", label: "Name (Arabic)" }, { name: "role", label: "Role", required: true }, { name: "joinDate", label: "Join date", type: "date", required: true },
            { name: "contractType", label: "Contract", type: "select", options: ["limited", "unlimited"] }, { name: "contractStart", label: "Contract start", type: "date", required: true }, { name: "basic", label: "Basic salary (AED)", required: true }, { name: "allowance", label: "Allowances (AED)" },
            { name: "authority", label: "Licence authority", type: "select", options: ["DHA", "DOH", "MOHAP", "DHCC", "OTHER"] }, { name: "licenceNo", label: "Licence number" }, { name: "licenceExpiry", label: "Licence expiry", type: "date" },
            { name: "eidExpiry", label: "Emirates ID expiry", type: "date" }, { name: "visaExpiry", label: "Visa expiry", type: "date" }, { name: "iban", label: "IBAN" }]} /></Card>}
        </>
      )}

      {tab === "expiry" && <Expiry ctx={ctx} />}

      {tab === "leave" && <Leave ctx={ctx} back={back} emps={emps.map((e) => ({ value: e._id, label: e.name }))} name={name} />}

      {tab === "payroll" && <Payroll ctx={ctx} back={back} />}

      {tab === "policy" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Working-time policy"><p className="mb-2 text-xs text-muted">Payroll, overtime and attendance refuse to run until this is set. No statutory values are assumed.</p>{can("hr:approve") ? <ActionForm action="hr.config" back={back} submit="Save" fields={[{ name: "hours", label: "Standard hours per day", type: "number", step: "0.5", required: true }, { name: "ot", label: "Overtime multiplier", type: "number", step: "0.05", required: true }, { name: "days", label: "Working days per month", type: "number", required: true }]} /> : <p className="text-sm text-muted">Approver access required.</p>}</Card>
          <Card title="Leave types">{can("hr:approve") ? <ActionForm action="hr.leaveType" back={back} submit="Save leave type" fields={[{ name: "code", label: "Code", required: true }, { name: "name", label: "Name", required: true }, { name: "days", label: "Days per year", type: "number", required: true }, { name: "paid", label: "Paid leave", type: "checkbox", defaultValue: true }]} /> : <p className="text-sm text-muted">Approver access required.</p>}</Card>
          <Card title="End-of-service policy"><p className="mb-2 text-xs text-muted">Enter the rule set HR/legal confirm applies. Calculations use only this configuration.</p>{can("hr:approve") ? <ActionForm action="hr.gratuityPolicy" back={back} submit="Save" fields={[{ name: "rate1", label: "Days/yr, first period", type: "number", required: true }, { name: "years1", label: "First period (years)", type: "number", required: true }, { name: "rate2", label: "Days/yr, thereafter", type: "number", required: true }, { name: "cap", label: "Cap (months of basic)", type: "number", required: true }]} /> : <p className="text-sm text-muted">Approver access required.</p>}</Card>
        </div>
      )}
    </div>
  );
}
type C = Awaited<ReturnType<typeof requireCtx>>;

async function Expiry({ ctx }: { ctx: C }) {
  const a = await documentExpiryAlerts(ctx, 90);
  return <Card title="Documents expiring within 90 days"><Table head={["Employee", "Document", "Expiry", ""]} empty="Nothing expiring soon.">{a.map((x, i) => <tr key={i}><td>{x.name}</td><td>{x.document}</td><td>{fmtDate(x.expiry)}</td><td>{x.expired ? <Badge tone="danger">expired</Badge> : <Badge tone="warn">expiring</Badge>}</td></tr>)}</Table></Card>;
}

async function Leave({ ctx, back, emps, name }: { ctx: C; back: string; emps: { value: string; label: string }[]; name: Map<string, string> }) {
  const rows = await listLeave(ctx);
  const can = (p: string) => ctx.permissions.includes(p as never);
  return (
    <>
      <Card title="Leave requests"><Table head={["Employee", "Type", "From", "To", "Days", "Status", ""]} empty={rows.length ? undefined : "None."}>{rows.map((l) => <tr key={l._id}><td>{name.get(l.employeeId)}</td><td>{l.typeCode}</td><td>{l.from}</td><td>{l.to}</td><td>{l.days}</td><td><Badge tone={l.status === "approved" ? "ok" : l.status === "rejected" ? "danger" : "warn"}>{l.status}</Badge></td><td>{l.status === "pending" && can("hr:approve") && <div className="flex gap-1"><ActionButton action="hr.leaveDecide" back={back} hidden={{ id: l._id, decision: "approve" }}>Approve</ActionButton><ActionButton action="hr.leaveDecide" back={back} hidden={{ id: l._id, decision: "reject" }} variant="ghost">Reject</ActionButton></div>}</td></tr>)}</Table></Card>
      {can("hr:create") && emps.length > 0 && <Card title="Request leave"><ActionForm action="hr.leave" back={back} submit="Request" fields={[{ name: "employeeId", label: "Employee", type: "select", options: emps }, { name: "typeCode", label: "Leave type code", required: true }, { name: "from", label: "From", type: "date", required: true }, { name: "to", label: "To", type: "date", required: true }, { name: "reason", label: "Reason" }]} /></Card>}
    </>
  );
}

async function Payroll({ ctx, back }: { ctx: C; back: string }) {
  const runs = await listPayrollRuns(ctx);
  const can = (p: string) => ctx.permissions.includes(p as never);
  return (
    <>
      <Card title="Payroll runs">
        <Table head={["Period", "Gross", "Net", "Status", ""]} empty={runs.length ? undefined : "No payroll runs."}>
          {runs.map((r) => <tr key={r._id}><td>{r.period}</td><td className="tabular-nums">{aed(fromDecimal128(r.totalGross).toFixed(2))}</td><td className="tabular-nums">{aed(fromDecimal128(r.totalNet).toFixed(2))}</td><td><Badge tone={r.status === "paid" ? "ok" : r.status === "approved" ? "info" : "warn"}>{r.status}</Badge></td>
            <td className="flex flex-wrap gap-1">{r.status === "draft" && can("hr:approve") && <ActionButton action="hr.payrollApprove" back={back} hidden={{ id: r._id }} variant="primary">Approve</ActionButton>}{r.status === "approved" && can("ledger:create") && <ActionButton action="hr.payrollPay" back={back} hidden={{ id: r._id }} variant="primary">Mark paid</ActionButton>}{r.status !== "draft" && can("hr:export") && <a className="rounded-ui border border-border px-2 py-1 text-xs hover:bg-surface-2" href={`/api/hr/payroll/${r._id}/export`}>Bank file (CSV)</a>}</td></tr>)}
        </Table>
        <p className="mt-2 text-xs text-muted">The preparer cannot approve their own run. The CSV is a generic layout, not the official WPS SIF format.</p>
      </Card>
      {can("hr:create") && <Card title="Prepare payroll"><ActionForm action="hr.payrollPrepare" back={back} submit="Prepare run" fields={[{ name: "period", label: "Period (YYYY-MM)", required: true, placeholder: "2026-11" }, { name: "recovery", label: "Advance recovery per employee (AED)" }]} /></Card>}
    </>
  );
}
