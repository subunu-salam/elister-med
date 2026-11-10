import { requireCtx } from "@/lib/session";
import { Alert, Badge, Card, NoAccess, PageHeader, Stat, Table } from "@/ui/kit";
import { ActionButton, ActionForm, fmtDateTime } from "@/ui/forms";
import { deliveryStats, listDeliveries, listTemplates } from "@/modules/communications/service";

const TONE: Record<string, "ok" | "warn" | "danger" | "neutral"> = { sent: "ok", failed: "warn", dead: "danger", skipped_consent: "neutral", skipped_optout: "neutral" };

export default async function CommsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireCtx();
  const { error } = await searchParams;
  if (!ctx.permissions.includes("communications:view")) return <NoAccess what="communications" />;
  const can = (p: string) => ctx.permissions.includes(p as never);
  const [tpl, del, stats] = await Promise.all([listTemplates(ctx), listDeliveries(ctx, 50), deliveryStats(ctx)]);
  return (
    <div className="space-y-4">
      <PageHeader title="Communications" sub="Templates, consent-aware sending and delivery log. The gateway is a SANDBOX: no real SMS, email or WhatsApp message leaves the system." />
      {error && <Alert>{error}</Alert>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5"><Stat label="Sent" value={stats.sent} tone="ok" /><Stat label="Failed (retrying)" value={stats.failed} tone={stats.failed ? "warn" : undefined} /><Stat label="Dead-lettered" value={stats.dead} tone={stats.dead ? "danger" : undefined} /><Stat label="Skipped: no consent" value={stats.skippedConsent} /><Stat label="Skipped: opted out" value={stats.skippedOptOut} /></div>
      <Card title="Templates"><Table head={["Key", "Channel", "Language", "Category", "Body"]} empty={tpl.length ? undefined : "No templates yet."}>{tpl.map((t) => <tr key={t._id}><td className="font-mono text-xs">{t.key}</td><td>{t.channel}</td><td>{t.language}</td><td><Badge tone={t.category === "marketing" ? "warn" : "neutral"}>{t.category}</Badge></td><td className="max-w-md text-xs">{t.body}</td></tr>)}</Table></Card>
      {can("communications:create") && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Save template"><ActionForm action="comm.template" back="/communications" submit="Save" fields={[{ name: "key", label: "Key", required: true }, { name: "channel", label: "Channel", type: "select", options: ["sms", "email", "whatsapp", "in_app"] }, { name: "language", label: "Language", type: "select", options: ["en", "ar"] }, { name: "category", label: "Category", type: "select", options: ["transactional", "marketing"] }, { name: "subject", label: "Subject (email)" }, { name: "body", label: "Body", type: "textarea", required: true, span: 3, hint: "Placeholders: {{patientName}} {{appointmentTime}} {{doctorName}} {{clinicName}} {{invoiceNumber}} {{amountDue}} {{link}}. Clinical wording is rejected on SMS/email/WhatsApp." }]} /></Card>
          <Card title="Send a message"><ActionForm action="comm.send" back="/communications" submit="Send" fields={[{ name: "patientId", label: "Patient ID", required: true }, { name: "templateKey", label: "Template key", required: true }, { name: "channel", label: "Channel", type: "select", options: ["sms", "email", "whatsapp", "in_app"] }]} /><div className="mt-3 flex gap-2 border-t border-border pt-3"><ActionButton action="comm.retry" back="/communications">Retry failed</ActionButton><ActionForm inline action="comm.reminders" back="/communications" submit="Send reminders" variant="outline" fields={[{ name: "hours", label: "Window (hours)", type: "number", defaultValue: 24 }]} /></div></Card>
        </div>
      )}
      <Card title="Delivery log"><Table head={["When", "To", "Channel", "Template", "Status", "Detail"]} empty={del.length ? undefined : "Nothing sent yet."}>{del.map((d) => <tr key={d._id}><td className="text-xs">{fmtDateTime(d.at)}</td><td dir="ltr" className="text-start text-xs">{d.to}</td><td>{d.channel}</td><td className="font-mono text-xs">{d.templateKey}</td><td><Badge tone={TONE[d.status]}>{d.status.replaceAll("_", " ")}</Badge></td><td className="text-xs text-muted">{d.reason ?? d.error ?? `attempts ${d.attempts}`}</td></tr>)}</Table></Card>
    </div>
  );
}
