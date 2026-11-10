import { requireCtx } from "@/lib/session";
import { fromDecimal128 } from "@/core/money";
import { Alert, Badge, Card, NoAccess, PageHeader, Table, aed } from "@/ui/kit";
import { ActionButton, ActionForm, fmtDateTime } from "@/ui/forms";
import { portalDoctors, portalOverview, portalQueueStatus, portalResults } from "@/modules/portal/service";

/** Patient portal: one signed-in patient, one record. Everything is derived from the session, never from the URL. */
export default async function PortalPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireCtx();
  const { error } = await searchParams;
  if (!ctx.roles.includes("patient_portal_user") || !ctx.patientId) return <NoAccess what="the patient portal" />;
  const [o, docs, results, queue] = await Promise.all([portalOverview(ctx), portalDoctors(ctx), portalResults(ctx), portalQueueStatus(ctx)]);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="My health portal" sub="Your appointments, invoices and released results" />
      {error && <Alert>{error}</Alert>}
      {queue && <Alert tone="ok">You are in the queue: token <strong>{queue.number}</strong> ({queue.status.replace("_", " ")}){queue.status === "waiting" && ` · about ${queue.estimatedWaitMinutes} min`}</Alert>}
      <Card title="Upcoming appointments"><Table head={["When", "Status", "Check-in code", ""]} empty="No upcoming appointments.">{o.upcoming.map((a) => <tr key={a.id}><td>{fmtDateTime(a.start)}</td><td><Badge tone="info">{a.status.replace("_", " ")}</Badge></td><td className="font-mono text-xs">{a.checkInToken}</td><td><ActionForm inline action="portal.cancel" back="/portal" hidden={{ id: a.id }} submit="Cancel" variant="ghost" fields={[{ name: "reason", label: "Reason" }]} /></td></tr>)}</Table><p className="mt-2 text-xs text-muted">Show the check-in code at the kiosk on the day of your visit.</p></Card>
      <Card title="Book an appointment"><ActionForm action="portal.book" back="/portal" submit="Book (30 min)" fields={[{ name: "doctorId", label: "Doctor", type: "select", options: docs.map((d) => ({ value: d.id, label: `${d.name}${d.specialty ? ` — ${d.specialty}` : ""}` })) }, { name: "start", label: "Date and time", type: "datetime-local", required: true }]} /></Card>
      <Card title="Invoices"><Table head={["Invoice", "Total", "Balance", "Status"]} empty="No invoices.">{o.invoices.map((i) => <tr key={i.id}><td className="font-mono text-xs">{i.number}</td><td>{aed(fromDecimal128(i.total as never).toFixed(2))}</td><td>{aed(fromDecimal128(i.balance as never).toFixed(2))}</td><td>{i.status.replace("_", " ")}</td></tr>)}</Table><p className="mt-2 text-xs text-muted">Online card payment is not available yet. Please pay at reception.</p></Card>
      <Card title="Released results">{results.length === 0 ? <p className="text-sm text-muted">No results have been released.</p> : results.map((r) => <div key={r.number} className="mb-3"><p className="text-sm font-medium">{r.number} · {fmtDateTime(r.releasedAt)}</p><Table head={["Test", "Result", "Unit", "Flag"]}>{r.tests.map((t, i) => <tr key={i}><td>{t.name}</td><td>{t.value}</td><td>{t.unit}</td><td>{t.flag?.replace("_", " ")}</td></tr>)}</Table></div>)}<p className="text-xs text-muted">Please discuss results with your doctor.</p></Card>
      <Card title="My details and preferences"><ActionForm action="portal.intake" back="/portal" submit="Save" fields={[{ name: "phone", label: "Mobile" }, { name: "email", label: "Email", type: "email" }, { name: "address", label: "Address" }, { name: "allergies", label: "Allergies you know of (comma separated)", span: 2, hint: "Staff will review before this is added to your record" }, { name: "sms", label: "SMS reminders", type: "checkbox", defaultValue: true }, { name: "emailPref", label: "Email", type: "checkbox", defaultValue: true }, { name: "whatsapp", label: "WhatsApp", type: "checkbox" }, { name: "marketing", label: "Offers and marketing", type: "checkbox" }, { name: "consent", label: "I consent to treatment and processing of my health data for my care", type: "checkbox" }]} /></Card>
      <ActionButton action="notify.readAll" back="/portal">Mark notifications read</ActionButton>
    </div>
  );
}
