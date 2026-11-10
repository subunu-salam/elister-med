import { requireCtx } from "@/lib/session";
import { Alert, Badge, Button, Card, Field, Input, NoAccess, PageHeader, Select } from "@/ui/kit";
import { ActionForm } from "@/ui/forms";
import { AI_PROVIDER, answerFacilityQuestion, demandForecast, findAvailableSlots, noShowRisk, revenueTrendSummary } from "@/modules/ai/service";
import { listDoctors } from "@/modules/appointments/service";
import { todayYmd } from "@/lib/range";

export default async function AiPage({ searchParams }: { searchParams: Promise<{ q?: string; lang?: string; doctor?: string; date?: string; error?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  if (!ctx.permissions.includes("ai:view")) return <NoAccess what="the assistants" />;
  const can = (p: string) => ctx.permissions.includes(p as never);
  const answer = sp.q ? await answerFacilityQuestion(ctx, sp.q, sp.lang === "ar" ? "ar" : "en") : null;
  const doctors = await listDoctors(ctx);
  const slots = sp.doctor ? await findAvailableSlots(ctx, { doctorId: sp.doctor, date: sp.date ?? todayYmd() }).catch(() => []) : null;
  const forecast = await demandForecast(ctx);
  const trend = can("reports:view") ? await revenueTrendSummary(ctx, { from: new Date(Date.now() - 30 * 86400000), to: new Date(Date.now() + 86400000) }).catch(() => null) : null;
  void noShowRisk;

  return (
    <div className="space-y-4">
      <PageHeader title="Assistants" sub={`Provider: ${AI_PROVIDER.name} (rule-based, runs inside this system). No external AI service is connected and no patient data leaves the platform.`} />
      {sp.error && <Alert>{sp.error}</Alert>}
      <Alert tone="warn">Assistants never diagnose, prescribe, sign, authorise care or make clinical decisions. Anything clinical is a draft that a clinician must review.</Alert>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Front-office assistant">
          <form className="space-y-2"><Field label="Ask about opening hours, doctors, fees, address, booking"><Input name="q" defaultValue={sp.q} placeholder="What are your opening hours?" /></Field><div className="flex gap-2"><Select name="lang" defaultValue={sp.lang ?? "en"} className="w-32"><option value="en">English</option><option value="ar">العربية</option></Select><Button>Ask</Button></div></form>
          {answer && <div className="mt-3 rounded-ui bg-surface-2 p-3 text-sm" dir={sp.lang === "ar" ? "rtl" : "ltr"}>{answer.answer}<div className="mt-1 flex gap-1"><Badge>AI-generated</Badge>{!answer.handled && <Badge tone="warn">not answered</Badge>}</div></div>}
        </Card>
        <Card title="Find available times">
          <form className="flex flex-wrap items-end gap-2"><Field label="Doctor"><Select name="doctor" defaultValue={sp.doctor}>{doctors.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}</Select></Field><Field label="Date"><Input name="date" type="date" defaultValue={sp.date ?? todayYmd()} /></Field><Button variant="outline">Search</Button></form>
          {slots && <p className="mt-3 text-sm">{slots.length ? slots.map((s) => new Date(s).toLocaleTimeString("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" })).join(" · ") : "No free times that day."}</p>}
          <p className="mt-2 text-xs text-muted">Uses the same availability rules as real booking. Book from Appointments, or via the booking form with the chosen time.</p>
        </Card>
        <Card title="Operational insights">
          {trend && <p className="text-sm">{trend.text} <Badge>computed, no model</Badge></p>}
          <p className="mt-3 text-sm font-medium">Expected appointments per weekday <span className="text-xs font-normal text-muted">({forecast.basis})</span></p>
          <div className="mt-1 flex gap-2 text-xs">{forecast.weekdayAverage.map((d) => <div key={d.dow} className="rounded-ui bg-surface-2 px-2 py-1 text-center"><div className="text-muted">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.dow]}</div><div className="font-semibold">{d.expected}</div></div>)}</div>
        </Card>
        {can("ai:create") && can("emr:update") && (
          <Card title="Clinical documentation assistant (draft only)">
            <ActionForm action="ai.dictation" back="/ai" submit="Create draft" fields={[{ name: "encounterId", label: "Encounter ID", required: true }, { name: "text", label: "Dictation / free text", type: "textarea", required: true, span: 3 }]} />
            <p className="mt-2 text-xs text-muted">The text is split into SOAP sections using cue words and stored as a draft. Review and accept it from the encounter; the note stays unsigned until you sign it.</p>
          </Card>
        )}
      </div>
      {can("org:update") && <Card title="Facility information used by the assistant"><ActionForm action="ai.settings" back="/ai" submit="Save" fields={[{ name: "hours", label: "Opening hours" }, { name: "address", label: "Address" }, { name: "phone", label: "Phone" }]} /></Card>}
    </div>
  );
}
