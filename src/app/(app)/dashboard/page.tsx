import { redirect } from "next/navigation";
import Link from "next/link";
import { Activity, Banknote, BookOpen, CalendarDays, Clock, FilePlus2, FlaskConical, Heart, HeartPulse, Landmark, ListOrdered, Percent, Pill, Receipt, Stethoscope, UserPlus, Users, Wallet } from "lucide-react";
import { requireCtx } from "@/lib/session";
import { parseRange } from "@/lib/range";
import { getPrefs, recentPatients, ALL_WIDGETS } from "@/modules/prefs/service";
import { dispatch } from "../dispatch";
import { executiveDashboard } from "@/modules/dashboard/executive";
import { receptionDashboard } from "@/modules/dashboard/reception";
import { doctorDashboard } from "@/modules/dashboard/doctor";
import { accountsDashboard } from "@/modules/dashboard/accounts";
import { DoctorCard } from "@/ui/DoctorCard";
import { listDoctors } from "@/modules/appointments/service";
import { photoVersions } from "@/modules/people/photos";
import { dubaiParts } from "@/core/time";
import { Badge, Button, Card, Donut, Input, PageHeader, Stat, aed } from "@/ui/kit";
import { tenantCol } from "@/core/db";
import { HalfGauge, WeekBars } from "@/ui/dashboard/charts";
import type { Ctx } from "@/core/rbac/authorize";

const DAY = 86400000;
/** Appointments per Dubai day for the last 7 days, with the same weekday a week earlier for comparison. */
async function weekActivity(ctx: Ctx) {
  const now = new Date();
  const dubaiMidnight = (d: Date) => { const l = new Date(d.getTime() + 4 * 3600000); return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()) - 4 * 3600000); };
  const end = new Date(dubaiMidnight(now).getTime() + DAY), start = new Date(end.getTime() - 14 * DAY);
  const rows = await tenantCol(ctx.orgId, "appointments").aggregate<{ _id: string; n: number }>([
    { $match: { start: { $gte: start, $lt: end }, status: { $nin: ["cancelled"] } } },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$start", timezone: "+04:00" } }, n: { $sum: 1 } } },
  ]);
  const by = new Map(rows.map((r) => [r._id, r.n]));
  const key = (d: Date) => new Date(d.getTime() + 4 * 3600000).toISOString().slice(0, 10);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(end.getTime() - (7 - i) * DAY);
    return { label: d.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", weekday: "short" }), value: by.get(key(d)) ?? 0, previous: by.get(key(new Date(d.getTime() - 7 * DAY))) ?? 0, today: i === 6 };
  });
  const thisWeek = days.reduce((a, d) => a + d.value, 0), lastWeek = days.reduce((a, d) => a + d.previous, 0);
  return { days, thisWeek, pct: lastWeek ? ((thisWeek - lastWeek) / lastWeek) * 100 : null };
}

type SP = Promise<{ from?: string; to?: string }>;

export default async function DashboardPage({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx();
  if (ctx.roles.includes("patient_portal_user")) redirect("/portal");
  const [sp, prefs, recent] = await Promise.all([searchParams, getPrefs(ctx), recentPatients(ctx)]);
  const show = (w: string) => prefs.widgets.includes(w);
  const { from, to, fromStr, toStr } = parseRange(sp);
  const can = (p: string) => ctx.permissions.includes(p as never);

  /* Independent widgets load side by side, not one after another. */
  const [exec, reception, doctor, accounts, doctors, week, patientCount] = await Promise.all([
    can("reports:view") && show("executive") ? executiveDashboard(ctx, { from, to }) : null,
    can("appointments:view") && can("queue:view") && show("reception") ? receptionDashboard(ctx, { day: new Date() }) : null,
    ctx.roles.includes("doctor") && show("doctor") ? doctorDashboard(ctx, { day: new Date() }).catch(() => null) : null,
    can("ledger:view") && show("accounts") ? accountsDashboard(ctx, { day: new Date() }) : null,
    can("appointments:view") ? listDoctors(ctx) : [],
    can("appointments:view") ? weekActivity(ctx) : null,
    can("patients:view") ? tenantCol(ctx.orgId, "patients").count({} as never) : null,
  ]);

  const photos = await photoVersions(ctx.orgId, doctors.map((d) => d.userId ?? d._id));
  const todayDow = dubaiParts(new Date()).dow;
  const launch = ([
    can("patients:create") && { href: "/patients/new", label: "Register patient", icon: UserPlus },
    can("appointments:view") && { href: "/appointments", label: "Appointments", icon: CalendarDays },
    can("patients:view") && { href: "/patients", label: "Patients", icon: Users },
    can("queue:view") && { href: "/queue", label: "Queue", icon: ListOrdered },
    can("billing:view") && { href: "/billing", label: "Billing", icon: Receipt },
    can("insurance:view") && { href: "/insurance", label: "Insurance", icon: Heart },
    can("pharmacy:view") && { href: "/pharmacy", label: "Pharmacy", icon: Pill },
    can("laboratory:view") && { href: "/laboratory", label: "Laboratory", icon: FlaskConical },
    can("reports:view") && { href: "/finance", label: "Finance", icon: Landmark },
    can("ledger:view") && { href: "/accounts", label: "Accounts", icon: BookOpen },
  ].filter(Boolean) as { href: string; label: string; icon: typeof Users }[]).slice(0, 10);
  const topDoctors = exec ? exec.current.revenueByDoctor.slice(0, 6) : [];
  const topMax = Math.max(...topDoctors.map((r) => Number(r.amount)), 1);

  return (
    <div className="space-y-8">
      <section aria-label="Overview" className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {patientCount !== null && <Stat label="Total patients" icon={<Users size={18} />} value={patientCount.toLocaleString("en-AE")} hint={exec ? <span>New <b className="text-fg">{exec.current.newPatients}</b> · Returning <b className="text-fg">{exec.current.returningPatients}</b> this period</span> : "Registered patients"} />}
        {week && <Stat label="Appointments this week" icon={<CalendarDays size={18} />} value={week.thisWeek} trend={{ pct: week.pct }} hint={reception ? <span>Today <b className="text-fg">{reception.todaysAppointments}</b> · Waiting <b className="text-fg">{reception.patientsWaiting}</b></span> : undefined} />}
        {exec && <Stat label="Revenue" icon={<Banknote size={18} />} value={aed(exec.current.revenue)} trend={{ pct: exec.delta.revenue.pct }} hint={`Net profit ${aed(exec.current.netProfit)}`} />}
        {exec ? <Stat label="Outstanding receivables" icon={<Activity size={18} />} value={aed(exec.current.outstandingReceivables)} hint={`No-show rate ${(exec.current.noShowRate * 100).toFixed(1)}% · Avg wait ${exec.current.avgWaitMinutes.toFixed(0)} min`} />
          : accounts ? <Stat label="Daily sales" icon={<Activity size={18} />} value={aed(accounts.dailySales)} hint={`Open invoices ${accounts.outstandingInvoices}`} /> : null}
      </section>

      {(week || exec) && (
        <section className="grid gap-4 xl:grid-cols-3">
          {week && (
            <Card className="xl:col-span-2" title="Analytics" sub="Appointments per day, this week against the same day last week"
              action={<span className="trend-chip text-primary"><CalendarDays size={12} /> Last 7 days</span>}>
              <div className="mb-4 flex items-baseline gap-3"><span className="text-[34px] font-semibold leading-none tabular-nums">{week.thisWeek}</span>{week.pct !== null && <span className="trend-chip text-primary">{week.pct >= 0 ? "↗" : "↘"} {Math.abs(week.pct).toFixed(1)}% <span className="font-normal text-muted">vs previous week</span></span>}</div>
              <WeekBars days={week.days} />
              <div className="mt-3 flex flex-wrap gap-4 text-xs text-muted"><span className="flex items-center gap-1.5"><span className="bar-fill inline-block size-3 rounded" />This week</span><span className="flex items-center gap-1.5"><span className="bar-hatch inline-block size-3 rounded" />Same day last week</span></div>
            </Card>
          )}
          {exec && (
            <Card title="Patients" sub="New and returning in the selected period">
              <HalfGauge a={{ label: "New", value: exec.current.newPatients }} b={{ label: "Returning", value: exec.current.returningPatients }} sub="Seen this period" centre={(exec.current.newPatients + exec.current.returningPatients).toLocaleString("en-AE")} />
              <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-2xl bg-surface-2 p-3"><dt className="text-xs text-muted">Appointments</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{exec.current.appointments}</dd></div>
                <div className="rounded-2xl bg-surface-2 p-3"><dt className="text-xs text-muted">No-show rate</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{(exec.current.noShowRate * 100).toFixed(1)}%</dd></div>
              </dl>
            </Card>
          )}
        </section>
      )}

      {launch.length > 0 && (
        <section aria-label="Quick start" className="space-y-3">
          <h2 className="text-[19px] font-semibold tracking-tight">Quick actions</h2>
          <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {launch.map((q) => (
              <Link key={q.href} href={q.href} className="panel panel-hover group flex items-center gap-3 rounded-[26px] p-4">
                <span className="ring-icon size-12 shrink-0 transition-transform duration-300 group-hover:scale-105"><q.icon size={20} strokeWidth={1.7} /></span>
                <span className="text-sm font-medium leading-tight">{q.label}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {doctors.length > 0 && (
        <section aria-label="Doctors" className="space-y-3">
          <h2 className="text-[19px] font-semibold tracking-tight">Our doctors</h2>
          <div className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
            {doctors.map((d) => <DoctorCard key={d._id} doctor={d} today={todayDow} photo={photos.get(d.userId ?? d._id)} canEditPhoto={can("hr:update")} bookHref={can("appointments:create") ? "/appointments#book" : undefined} />)}
          </div>
        </section>
      )}

      {exec && (
        <section aria-label="Executive KPIs" className="space-y-4">
          <PageHeader title="Performance" sub="Computed from the ledger, appointments and queue for the selected period, compared with the period before it."
            actions={<form className="flex flex-wrap items-end gap-2"><Input name="from" type="date" defaultValue={fromStr} aria-label="From" className="w-40" /><Input name="to" type="date" defaultValue={toStr} aria-label="To" className="w-40" /><Button variant="outline">Apply</Button></form>} />
          <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Revenue" icon={<Banknote size={16} />} value={aed(exec.current.revenue)} trend={{ pct: exec.delta.revenue.pct }} hint="vs previous period" />
            <Stat label="Net profit" icon={<Wallet size={16} />} value={aed(exec.current.netProfit)} trend={{ pct: exec.delta.netProfit.pct }} hint="vs previous" />
            <Stat label="Outstanding receivables" icon={<Activity size={16} />} value={aed(exec.current.outstandingReceivables)} tone={Number(exec.current.outstandingReceivables) > 0 ? "warn" : undefined} />
            <Stat label="Appointments" icon={<CalendarDays size={16} />} value={exec.current.appointments} trend={{ pct: exec.delta.appointments.pct }} hint="vs previous" />
            <Stat label="New patients" icon={<UserPlus size={16} />} value={exec.current.newPatients} />
            <Stat label="Returning patients" icon={<Users size={16} />} value={exec.current.returningPatients} />
            <Stat label="No-show rate" icon={<Percent size={16} />} value={`${(exec.current.noShowRate * 100).toFixed(1)}%`} />
            <Stat label="Avg wait (min)" icon={<Clock size={16} />} value={exec.current.avgWaitMinutes.toFixed(1)} />
          </div>
          <div className="grid gap-3 lg:grid-cols-5">
            <section className="hero-grad relative overflow-hidden rounded-[32px] p-6 text-white lg:col-span-3">
              <h2 className="text-[17px] font-medium">Revenue by doctor</h2>
              <p className="mt-0.5 text-sm text-white/75">Top earners in the selected period.</p>
              {topDoctors.length === 0 ? <p className="mt-6 text-sm text-white/80">No revenue in this period.</p> : (
                <ul className="mt-5 space-y-2">
                  {topDoctors.map((r) => (
                    <li key={r.key} className="relative overflow-hidden rounded-2xl bg-white/15 px-4 py-3">
                      <span aria-hidden className="absolute inset-y-0 start-0 bg-white/20" style={{ width: `${Math.max(4, (Number(r.amount) / topMax) * 100)}%` }} />
                      <div className="relative flex items-center justify-between gap-3 text-sm"><span className="truncate font-medium">{r.key}</span><span className="tabular-nums">{aed(r.amount)}</span></div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <Card className="lg:col-span-2" title="Revenue by department"><Donut parts={exec.current.revenueByDepartment.map((r) => ({ label: r.key, value: Number(r.amount), display: aed(r.amount) }))} centre={<span>Total<br /><strong className="text-sm text-fg">{aed(exec.current.revenue)}</strong></span>} /></Card>
          </div>
        </section>
      )}

      {reception && (
        <section aria-label="Reception" className="space-y-3">
          <h2 className="text-[19px] font-semibold tracking-tight">Reception today</h2>
          <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-5">
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
          <h2 className="text-[19px] font-semibold tracking-tight">My day</h2>
          <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Consultations" icon={<Stethoscope size={16} />} value={doctor.todaysConsultations} />
            <Stat label="Waiting" icon={<Clock size={16} />} value={doctor.waitingPatients} />
            <Stat label="Unsigned notes" icon={<FilePlus2 size={16} />} value={doctor.pendingNotes} tone={doctor.pendingNotes ? "warn" : undefined} />
            <Stat label="Current patient" icon={<HeartPulse size={16} />} value={doctor.currentPatient ? <Badge tone="info">In consult</Badge> : "—"} />
          </div>
        </section>
      )}

      {accounts && (
        <section aria-label="Accounts" className="space-y-3">
          <h2 className="text-[19px] font-semibold tracking-tight">Finance today</h2>
          <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Cash collected" icon={<Banknote size={16} />} value={aed(accounts.cashCollected)} />
            <Stat label="Card collected" icon={<Wallet size={16} />} value={aed(accounts.cardCollected)} />
            <Stat label="Daily sales" icon={<Activity size={16} />} value={aed(accounts.dailySales)} />
            <Stat label="Open invoices" icon={<FilePlus2 size={16} />} value={accounts.outstandingInvoices} hint={`Receivables ${aed(accounts.receivablesTotal)}`} />
          </div>
        </section>
      )}

      {recent.length > 0 && <Card title="Recently opened patients"><ul className="flex flex-wrap gap-2">{recent.map((r) => <li key={r.id}><Link className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-2 px-4 py-2 text-sm transition hover:bg-bg" href={`/patients/${r.id}`}>{r.fullName} <span className="font-mono text-xs text-muted">{r.mrn}</span></Link></li>)}</ul></Card>}

      <details className="panel rounded-[28px] px-6 py-5 text-sm"><summary className="cursor-pointer font-medium">Customise my dashboard</summary>
        <form action={dispatch} className="mt-3 flex flex-wrap items-center gap-4"><input type="hidden" name="_a" value="prefs.widgets" /><input type="hidden" name="_back" value="/dashboard" />
          {ALL_WIDGETS.map((w) => <label key={w} className="flex items-center gap-1.5 capitalize"><input type="checkbox" name="widget" value={w} defaultChecked={show(w)} /> {w}</label>)}<Button variant="outline">Save</Button></form>
        <p className="mt-2 text-xs text-muted">Only widgets your role may see are ever shown; this hides the ones you do not want.</p></details>

      {!exec && !reception && !doctor && !accounts && <Card><p className="text-sm text-muted">No dashboard widgets are available for your role.</p></Card>}
    </div>
  );
}
