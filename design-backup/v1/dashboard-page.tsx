import { redirect } from "next/navigation";
import Link from "next/link";
import { Activity, Banknote, CalendarDays, Clock, FilePlus2, HeartPulse, Percent, Stethoscope, UserPlus, Users, Wallet } from "lucide-react";
import { requireCtx } from "@/lib/session";
import { parseRange } from "@/lib/range";
import { getPrefs, recentPatients, ALL_WIDGETS } from "@/modules/prefs/service";
import { dispatch } from "../dispatch";
import { executiveDashboard } from "@/modules/dashboard/executive";
import { receptionDashboard } from "@/modules/dashboard/reception";
import { doctorDashboard } from "@/modules/dashboard/doctor";
import { accountsDashboard } from "@/modules/dashboard/accounts";
import { BRAND } from "@/ui/brand";
import { Badge, BarList, Button, Card, Donut, Input, PageHeader, Stat, aed } from "@/ui/kit";

type SP = Promise<{ from?: string; to?: string }>;
const dubaiDate = () => new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", weekday: "long", day: "numeric", month: "long", year: "numeric" });
const greeting = () => { const h = Number(new Date().toLocaleString("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", hour12: false })); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };

export default async function DashboardPage({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx();
  if (ctx.roles.includes("patient_portal_user")) redirect("/portal");
  const sp = await searchParams;
  const prefs = await getPrefs(ctx);
  const recent = await recentPatients(ctx);
  const show = (w: string) => prefs.widgets.includes(w);
  const { from, to, fromStr, toStr } = parseRange(sp);
  const can = (p: string) => ctx.permissions.includes(p as never);

  const exec = can("reports:view") && show("executive") ? await executiveDashboard(ctx, { from, to }) : null;
  const reception = can("appointments:view") && can("queue:view") && show("reception") ? await receptionDashboard(ctx, { day: new Date() }) : null;
  const doctor = ctx.roles.includes("doctor") && show("doctor") ? await doctorDashboard(ctx, { day: new Date() }).catch(() => null) : null;
  const accounts = can("ledger:view") && show("accounts") ? await accountsDashboard(ctx, { day: new Date() }) : null;

  const quick = [
    can("patients:create") && { href: "/patients/new", label: "Register patient", icon: UserPlus },
    can("appointments:create") && { href: "/appointments", label: "Book appointment", icon: CalendarDays },
    can("billing:view") && { href: "/billing", label: "Billing", icon: FilePlus2 },
    can("queue:view") && { href: "/queue", label: "Queue", icon: Users },
  ].filter(Boolean) as { href: string; label: string; icon: typeof Users }[];

  return (
    <div className="space-y-6">
      <section className="brand-grad page-in relative overflow-hidden rounded-3xl p-6 text-white shadow-[var(--shadow-pop)] md:p-8">
        <div aria-hidden className="pointer-events-none absolute -end-16 -top-16 size-72 rounded-full bg-white/10 blur-2xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-24 start-1/3 size-72 rounded-full bg-cyan-200/20 blur-3xl" />
        <div className="relative flex flex-wrap items-end justify-between gap-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-100">{dubaiDate()}</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">{greeting()}, {ctx.name.replace(/\(.*?\)/g, "").trim().split(" ")[0]}</h1>
            <p className="mt-1.5 max-w-xl text-sm text-white/75">{BRAND.tagline}.</p>
          </div>
          {quick.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {quick.map((q) => <Link key={q.href} href={q.href} className="inline-flex items-center gap-2 rounded-xl bg-white/15 px-3.5 py-2.5 text-sm font-medium ring-1 ring-white/20 backdrop-blur transition hover:bg-white/25"><q.icon size={16} />{q.label}</Link>)}
            </div>
          )}
        </div>
      </section>

      {exec && (
        <section aria-label="Executive KPIs" className="space-y-4">
          <PageHeader title="Performance" sub="Computed from the ledger, appointments and queue for the selected period, compared with the period before it."
            actions={<form className="flex items-end gap-2"><Input name="from" type="date" defaultValue={fromStr} aria-label="From" /><Input name="to" type="date" defaultValue={toStr} aria-label="To" /><Button variant="outline">Apply</Button></form>} />
          <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Revenue" icon={<Banknote size={16} />} value={aed(exec.current.revenue)} trend={{ pct: exec.delta.revenue.pct }} hint="vs previous period" />
            <Stat label="Net profit" icon={<Wallet size={16} />} value={aed(exec.current.netProfit)} trend={{ pct: exec.delta.netProfit.pct }} hint="vs previous" />
            <Stat label="Outstanding receivables" icon={<Activity size={16} />} value={aed(exec.current.outstandingReceivables)} tone={Number(exec.current.outstandingReceivables) > 0 ? "warn" : undefined} />
            <Stat label="Appointments" icon={<CalendarDays size={16} />} value={exec.current.appointments} trend={{ pct: exec.delta.appointments.pct }} hint="vs previous" />
            <Stat label="New patients" icon={<UserPlus size={16} />} value={exec.current.newPatients} />
            <Stat label="Returning patients" icon={<Users size={16} />} value={exec.current.returningPatients} />
            <Stat label="No-show rate" icon={<Percent size={16} />} value={`${(exec.current.noShowRate * 100).toFixed(1)}%`} />
            <Stat label="Avg wait (min)" icon={<Clock size={16} />} value={exec.current.avgWaitMinutes.toFixed(1)} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Revenue by doctor"><BarList rows={exec.current.revenueByDoctor.map((r) => ({ label: r.key, value: Number(r.amount), display: aed(r.amount) }))} empty="No revenue in this period." /></Card>
            <Card title="Revenue by department"><Donut parts={exec.current.revenueByDepartment.map((r) => ({ label: r.key, value: Number(r.amount), display: aed(r.amount) }))} centre={<span>Total<br /><strong className="text-sm text-fg">{aed(exec.current.revenue)}</strong></span>} /></Card>
          </div>
        </section>
      )}

      {reception && (
        <section aria-label="Reception" className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Reception · today</h2>
          <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat label="Appointments" icon={<CalendarDays size={16} />} value={reception.todaysAppointments} />
            <Stat label="Expected arrivals" icon={<UserPlus size={16} />} value={reception.expectedArrivals} />
            <Stat label="Waiting" icon={<Clock size={16} />} value={reception.patientsWaiting} tone={reception.patientsWaiting > 5 ? "warn" : undefined} />
            <Stat label="In consultation" icon={<Stethoscope size={16} />} value={reception.inConsult} />
            <Stat label="No-shows" icon={<Percent size={16} />} value={reception.noShows} />
          </div>
        </section>
      )}

      {doctor && (
        <section aria-label="Doctor" className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">My day</h2>
          <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Consultations" icon={<Stethoscope size={16} />} value={doctor.todaysConsultations} />
            <Stat label="Waiting" icon={<Clock size={16} />} value={doctor.waitingPatients} />
            <Stat label="Unsigned notes" icon={<FilePlus2 size={16} />} value={doctor.pendingNotes} tone={doctor.pendingNotes ? "warn" : undefined} />
            <Stat label="Current patient" icon={<HeartPulse size={16} />} value={doctor.currentPatient ? <Badge tone="info">In consult</Badge> : "—"} />
          </div>
        </section>
      )}

      {accounts && (
        <section aria-label="Accounts" className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Finance · today</h2>
          <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Cash collected" icon={<Banknote size={16} />} value={aed(accounts.cashCollected)} />
            <Stat label="Card collected" icon={<Wallet size={16} />} value={aed(accounts.cardCollected)} />
            <Stat label="Daily sales" icon={<Activity size={16} />} value={aed(accounts.dailySales)} />
            <Stat label="Open invoices" icon={<FilePlus2 size={16} />} value={accounts.outstandingInvoices} hint={`Receivables ${aed(accounts.receivablesTotal)}`} />
          </div>
        </section>
      )}

      {recent.length > 0 && <Card title="Recently opened patients"><ul className="flex flex-wrap gap-2">{recent.map((r) => <li key={r.id}><Link className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface px-3.5 py-2 text-sm transition hover:border-primary/40 hover:bg-surface-2" href={`/patients/${r.id}`}>{r.fullName} <span className="font-mono text-xs text-muted">{r.mrn}</span></Link></li>)}</ul></Card>}

      <details className="rounded-2xl border border-border bg-surface p-4 text-sm shadow-card"><summary className="cursor-pointer font-semibold">Customise my dashboard</summary>
        <form action={dispatch} className="mt-3 flex flex-wrap items-center gap-4"><input type="hidden" name="_a" value="prefs.widgets" /><input type="hidden" name="_back" value="/dashboard" />
          {ALL_WIDGETS.map((w) => <label key={w} className="flex items-center gap-1.5 capitalize"><input type="checkbox" name="widget" value={w} defaultChecked={show(w)} /> {w}</label>)}<Button variant="outline">Save</Button></form>
        <p className="mt-2 text-xs text-muted">Only widgets your role may see are ever shown; this hides the ones you do not want.</p></details>

      {!exec && !reception && !doctor && !accounts && <Card><p className="text-sm text-muted">No dashboard widgets are available for your role.</p></Card>}
    </div>
  );
}
