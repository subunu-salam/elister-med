import Link from "next/link";
import { requireCtx } from "@/lib/session";
import { todayYmd } from "@/lib/range";
import { dubaiParts, hhmmToMinutes } from "@/core/time";
import { listAppointments, listDoctors } from "@/modules/appointments/service";
import { getPatient, patientNames } from "@/modules/patients/service";
import { Alert, Badge, Button, Card, Field, Input, NoAccess, PageHeader, Select, Table } from "@/ui/kit";
import { bookAction, cancelAction, checkInAction, noShowAction } from "./actions";
import { DayGrid, type GridDoctor } from "./DayGrid";
import { PatientPicker } from "./PatientPicker";
import { DoctorCard } from "@/ui/DoctorCard";
import { photoVersions } from "@/modules/people/photos";

export default async function AppointmentsPage({ searchParams }: { searchParams: Promise<{ date?: string; patient?: string; error?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  if (!ctx.permissions.includes("appointments:view")) return <NoAccess what="appointments" />;
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayYmd();
  const from = new Date(`${date}T00:00:00+04:00`);
  const to = new Date(from.getTime() + 86400000);
  const dow = dubaiParts(from).dow;

  const doctors = await listDoctors(ctx);
  const appts = await listAppointments(ctx, { from, to });
  const lookup = await patientNames(ctx, appts.map((a) => a.patientId));
  const names = new Map([...lookup].map(([id, v]) => [id, v.fullName]));
  const pre = sp.patient ? await getPatient(ctx, sp.patient).catch(() => null) : null;

  const grid: GridDoctor[] = doctors.map((d) => ({
    id: d._id, name: d.name, slot: d.slotMinutes, startMin: hhmmToMinutes(d.workStart), endMin: hhmmToMinutes(d.workEnd), works: d.workDays.includes(dow),
    appts: appts.filter((a) => a.doctorId === d._id).map((a) => {
      const s = dubaiParts(a.start).minutes;
      return { id: a._id, label: names.get(a.patientId) ?? "Patient", startMin: s, endMin: dubaiParts(new Date(a.end.getTime() - 1)).minutes + 1, status: a.status };
    }),
  }));
  const dayName = new Date(from).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", weekday: "long", day: "numeric", month: "long" });
  const prev = new Date(from.getTime() - 86400000), next = new Date(from.getTime() + 86400000);
  const ymd = (d: Date) => dubaiParts(d).ymd;
  const docName = new Map(doctors.map((d) => [d._id, d.name]));
  const can = (p: string) => ctx.permissions.includes(p as never);
  const photos = await photoVersions(ctx.orgId, doctors.map((d) => d.userId ?? d._id));
  const today = dubaiParts(new Date()).dow;

  return (
    <div className="space-y-4">
      <PageHeader title="Appointments" sub={dayName}
        actions={<div className="flex items-center gap-1"><Link className="rounded-ui border border-border px-3 py-2 text-sm" href={`?date=${ymd(prev)}`}>←</Link><form><Input type="date" name="date" defaultValue={date} aria-label="Date" /></form><Link className="rounded-ui border border-border px-3 py-2 text-sm" href={`?date=${ymd(next)}`}>→</Link></div>} />
      {sp.error && <Alert>{sp.error}</Alert>}

      {doctors.length > 0 && (
        <section aria-label="Our doctors" className="space-y-3">
          <h2 className="text-[22px] font-light tracking-tight">Our doctors</h2>
          <div className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
            {doctors.map((d) => <DoctorCard key={d._id} doctor={d} today={today} photo={photos.get(d.userId ?? d._id)} canEditPhoto={can("hr:update")} bookHref={can("appointments:create") ? `?date=${date}#book` : undefined} />)}
          </div>
        </section>
      )}

      {can("appointments:create") && (
        <Card title="Book appointment" className="scroll-mt-24" id="book">
          <form action={bookAction} className="grid gap-3 md:grid-cols-6">
            <input type="hidden" name="date" value={date} />
            <div className="md:col-span-2"><Field label="Patient"><PatientPicker initial={pre ? { id: pre._id, label: `${pre.fullName} (${pre.mrn})` } : undefined} /></Field></div>
            <Field label="Doctor"><Select name="doctorId" required>{doctors.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}</Select></Field>
            <Field label="Time (Dubai)"><Input name="time" type="time" required defaultValue="10:00" step={300} /></Field>
            <Field label="Minutes"><Select name="minutes" defaultValue="20"><option>10</option><option>15</option><option>20</option><option>30</option><option>45</option><option>60</option></Select></Field>
            <div className="flex items-end"><Button className="w-full">Book</Button></div>
          </form>
        </Card>
      )}

      <Card title="Schedule" action={<span className="text-xs text-muted">Drag a booked slot to reschedule</span>}>
        {doctors.length ? <DayGrid date={date} doctors={grid} /> : <p className="text-sm text-muted">No doctors configured.</p>}
      </Card>

      <Card title={`Appointments (${appts.length})`}>
        <Table head={["Time", "Patient", "Doctor", "Status", "Actions"]} empty={appts.length ? undefined : "No appointments on this day."}>
          {appts.map((a) => (
            <tr key={a._id}>
              <td className="tabular-nums">{new Date(a.start).toLocaleTimeString("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" })}</td>
              <td><Link className="text-primary hover:underline" href={`/patients/${a.patientId}`}>{names.get(a.patientId)}</Link></td>
              <td>{docName.get(a.doctorId)}</td>
              <td><Badge tone={a.status === "completed" ? "ok" : a.status === "cancelled" || a.status === "no_show" ? "danger" : "info"}>{a.status.replace("_", " ")}</Badge></td>
              <td>
                {a.status === "booked" && (
                  <div className="flex flex-wrap items-center gap-2">
                    {can("queue:create") && <form action={checkInAction} className="flex items-center gap-1"><input type="hidden" name="id" value={a._id} /><input type="hidden" name="date" value={date} /><label className="flex items-center gap-1 text-xs text-muted"><input type="checkbox" name="priority" /> priority</label><Button variant="outline" className="px-2 py-1 text-xs">Check in</Button></form>}
                    {can("appointments:update") && <form action={noShowAction}><input type="hidden" name="id" value={a._id} /><input type="hidden" name="date" value={date} /><Button variant="ghost" className="px-2 py-1 text-xs">No-show</Button></form>}
                    {can("appointments:update") && <form action={cancelAction} className="flex gap-1"><input type="hidden" name="id" value={a._id} /><input type="hidden" name="date" value={date} /><Input name="reason" required placeholder="Reason" className="h-7 w-28 py-1 text-xs" aria-label="Cancellation reason" /><Button variant="ghost" className="px-2 py-1 text-xs">Cancel</Button></form>}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
