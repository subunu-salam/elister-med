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
import { listDoctors } from "@/modules/appointments/service";
import { dubaiParts } from "@/core/time";
import { Badge, Button, Card, Donut, Input, PageHeader, Stat, aed } from "@/ui/kit";
import { tenantCol } from "@/core/db";
import { MiniCalendar, PairBars, RingTotal } from "@/ui/dashboard/charts";
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

/** Today's appointments (Dubai) with patient and doctor names, and which days of this month have bookings. */
async function todayAndMonth(ctx: Ctx) {
  const l = new Date(Date.now() + 4 * 3600000);
  const y = l.getUTCFullYear(), m = l.getUTCMonth(), d = l.getUTCDate();
  const at = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd) - 4 * 3600000);
  const appts = tenantCol<{ _id: string; start: Date; patientId: string; doctorId: string; status: string; type: string }>(ctx.orgId, "appointments");
  const [today, month] = await Promise.all([
    appts.find({ start: { $gte: at(y, m, d), $lt: at(y, m, d + 1) }, status: { $nin: ["cancelled"] } } as never, { sort: { start: 1 }, limit: 8 }),
    appts.aggregate<{ _id: number }>([{ $match: { start: { $gte: at(y, m, 1), $lt: at(y, m + 1, 1) }, status: { $nin: ["cancelled"] } } }, { $group: { _id: { $dayOfMonth: { date: "$start", timezone: "+04:00" } } } }]),
  ]);
  const [pats, docs] = await Promise.all([
    tenantCol<{ _id: string; fullName: string }>(ctx.orgId, "patients").find({ _id: { $in: today.map((a) => a.patientId) } } as never, { limit: 20 }),
    tenantCol<{ _id: string; name: string }>(ctx.orgId, "staff").find({ _id: { $in: today.map((a) => a.doctorId) } } as never, { limit: 20 }),
  ]);
  const pn = new Map(pats.map((p) => [p._id, p.fullName])), dn = new Map(docs.map((x) => [x._id, x.name]));
  return { y, m, d, busy: new Set(month.map((x) => x._id)), list: today.map((a) => ({ id: a._id, time: a.start.toLocaleTimeString("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" }), patient: pn.get(a.patientId) ?? "Patient", doctor: dn.get(a.doctorId) ?? "", status: a.status, type: a.type })) };
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
  const [exec, reception, doctor, accounts, doctors, week, patientCount, agenda] = await Promise.all([
    can("reports:view") && show("executive") ? executiveDashboard(ctx, { from, to }) : null,
    can("appointments:view") && can("queue:view") && show("reception") ? receptionDashboard(ctx, { day: new Date() }) : null,
    ctx.roles.includes("doctor") && show("doctor") ? doctorDashboard(ctx, { day: new Date() }).catch(() => null) : null,
    can("ledger:view") && show("accounts") ? accountsDashboard(ctx, { day: new Date() }) : null,
    can("appointments:view") ? listDoctors(ctx) : [],
    can("appointments:view") ? weekActivity(ctx) : null,
    can("patients:view") ? tenantCol(ctx.orgId, "patients").count({} as never) : null,
    can("appointments:view") && can("patients:view") ? todayAndMonth(ctx) : null,
  ]);

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
      <div className="page-in flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-[24px] font-semibold tracking-tight">Dashboard</h1><p className="text-sm text-muted">Today at the clinic, at a glance.</p></div>
        <div className="flex gap-2">
          {can("appointments:create") && <Link href="/appointments#book" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface px-3.5 py-2 text-sm font-medium hover:bg-surface-2"><CalendarDays size={15} />Book appointment</Link>}
          {can("patients:create") && <Link href="/patients/new" className="btn-gloss inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium"><UserPlus size={15} />Register patient</Link>}
        </div>
      </div>

      <div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <section aria-label="Overview" className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {patientCount !== null && <Stat label="Total patients" icon={<Users size={16} />} value={patientCount.toLocaleString("en-AE")} hint={exec ? `${exec.current.newPatients} new this period` : "Registered"} />}
            {week && <Stat label="Appointments" icon={<CalendarDays size={16} />} value={week.thisWeek} trend={{ pct: week.pct }} hint={reception ? `${reception.todaysAppointments} today · ${reception.patientsWaiting} waiting` : "Last 7 days"} />}
            {exec && <Stat label="Revenue" icon={<Banknote size={16} />} value={aed(exec.current.revenue)} trend={{ pct: exec.delta.revenue.pct }} hint={`Net profit ${aed(exec.current.netProfit)}`} />}
            {exec ? <Stat label="Receivables" icon={<Activity size={16} />} value={aed(exec.current.outstandingReceivables)} hint={`No-show ${(exec.current.noShowRate * 100).toFixed(1)}% · wait ${exec.current.avgWaitMinutes.toFixed(0)} min`} />
              : accounts ? <Stat label="Daily sales" icon={<Activity size={16} />} value={aed(accounts.dailySales)} hint={`Open invoices ${accounts.outstandingInvoices}`} /> : null}
          </section>

          {(week || exec) && (
            <section className="grid gap-5 xl:grid-cols-5">
              {week && (
                <Card className="xl:col-span-3" title="Patient visits" sub="Appointments per day"
                  action={<div className="flex items-center gap-3 text-xs text-muted"><span className="flex items-center gap-1.5"><span className="bar-fill size-2.5 rounded-full" />This week</span><span className="flex items-center gap-1.5"><span className="bar-prev size-2.5 rounded-full" />Last week</span></div>}>
                  <div className="mb-3 flex items-baseline gap-2"><span className="text-2xl font-semibold tabular-nums">{week.thisWeek}</span><span className="text-xs text-muted">visits in the last 7 days</span>{week.pct !== null && <span className={`trend-chip ${week.pct >= 0 ? "trend-up" : "trend-down"}`}>{week.pct >= 0 ? "+" : "−"}{Math.abs(week.pct).toFixed(1)}%</span>}</div>
                  <PairBars days={week.days} />
                </Card>
              )}
              {exec && (
                <Card className="xl:col-span-2" title="Patient overview" sub="New and returning, selected period">
                  <RingTotal parts={[{ label: "New patients", value: exec.current.newPatients }, { label: "Returning patients", value: exec.current.returningPatients }]} total={(exec.current.newPatients + exec.current.returningPatients).toLocaleString("en-AE")} caption="this period" />
                </Card>
              )}
            </section>
          )}

          {doctors.length > 0 && (
            <Card title="Doctor's schedule" sub="Who is in today" action={<Link href="/appointments" className="text-xs font-medium text-primary hover:underline">View all</Link>}>
              <ul className="grid gap-x-6 sm:grid-cols-2">
                {doctors.map((d) => { const on = d.workDays.includes(todayDow); return (
                  <li key={d._id} className="flex items-center gap-3 border-b border-border py-3 last:border-b-0 sm:[&:nth-last-child(2)]:border-b-0">
                    <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-tint text-xs font-semibold text-primary">{d.name.replace(/^Dr\.?\s*/, "").split(" ").map((w) => w[0]).slice(0, 2).join("")}</span>
                    <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{d.name}</div><div className="truncate text-xs text-muted">{d.specialty ?? "Doctor"} · {d.workStart}–{d.workEnd}</div></div>
                    <Badge tone={on ? "ok" : "danger"}>{on ? "Available" : "Unavailable"}</Badge>
                  </li>); })}
              </ul>
            </Card>
          )}
        </div>

        {agenda && (
          <aside className="space-y-5" aria-label="Today">
            <Card><MiniCalendar year={agenda.y} month={agenda.m} today={agenda.d} busy={agenda.busy} /></Card>
            <Card title="Today's appointments" action={<Link href="/queue" className="text-xs font-medium text-primary hover:underline">Queue</Link>}>
              {agenda.list.length === 0 ? <p className="text-sm text-muted">No appointments today.</p> : (
                <ol className="relative space-y-3 border-s border-dashed border-border ps-4">
                  {agenda.list.map((a) => (
                    <li key={a.id} className="relative">
                      <span aria-hidden className={`absolute -start-[21px] top-3 size-2.5 rounded-full ring-4 ring-surface ${a.status === "completed" ? "bg-ok" : a.status === "in_consult" ? "bg-accent" : "bg-primary"}`} />
                      <div className="rounded-xl border border-border bg-surface-2 p-3">
                        <div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{a.patient}</span><span className="text-xs tabular-nums text-muted">{a.time}</span></div>
                        <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-muted"><span className="truncate">{a.doctor}{a.type ? ` · ${a.type}` : ""}</span><span className="capitalize">{a.status.replace("_", " ")}</span></div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </aside>
        )}
      </div>

      {launch.length > 0 && (
        <section aria-label="Quick start" className="space-y-3">
          <h2 className="text-[19px] font-semibold tracking-tight">Quick actions</h2>
          <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {launch.map((q) => (
              <Link key={q.href} href={q.href} className="panel panel-hover group flex items-center gap-3 rounded-2xl p-4">
                <span className="ring-icon size-12 shrink-0 transition-transform duration-300 group-hover:scale-105"><q.icon size={20} strokeWidth={1.7} /></span>
                <span className="text-sm font-medium leading-tight">{q.label}</span>
              </Link>
            ))}
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
            <section className="hero-grad relative overflow-hidden rounded-2xl p-6 text-white lg:col-span-3">
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

      <details className="panel rounded-2xl px-6 py-5 text-sm"><summary className="cursor-pointer font-medium">Customise my dashboard</summary>
        <form action={dispatch} className="mt-3 flex flex-wrap items-center gap-4"><input type="hidden" name="_a" value="prefs.widgets" /><input type="hidden" name="_back" value="/dashboard" />
          {ALL_WIDGETS.map((w) => <label key={w} className="flex items-center gap-1.5 capitalize"><input type="checkbox" name="widget" value={w} defaultChecked={show(w)} /> {w}</label>)}<Button variant="outline">Save</Button></form>
        <p className="mt-2 text-xs text-muted">Only widgets your role may see are ever shown; this hides the ones you do not want.</p></details>

      {!exec && !reception && !doctor && !accounts && <Card><p className="text-sm text-muted">No dashboard widgets are available for your role.</p></Card>}
    </div>
  );
}
