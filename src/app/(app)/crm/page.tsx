import { requireCtx } from "@/lib/session";
import { Alert, Badge, Card, NoAccess, Stat, Table, Tabs } from "@/ui/kit";
import { BrandBanner } from "@/ui/brand";
import { ActionButton, ActionForm, fmtDateTime } from "@/ui/forms";
import { buildRecallList, listComplaints, listDueFollowUps, listEnquiries, referralAnalysis, satisfactionSummary } from "@/modules/crm/service";
import { contactInfo } from "@/modules/patients/service";
import { tenantCol } from "@/core/db";

const TABS = [{ key: "enquiries", label: "Enquiries" }, { key: "followups", label: "Follow-ups" }, { key: "campaigns", label: "Recall campaigns" }, { key: "feedback", label: "Feedback & complaints" }, { key: "referrals", label: "Referral sources" }];

export default async function CrmPage({ searchParams }: { searchParams: Promise<{ tab?: string; error?: string; campaign?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  if (!ctx.permissions.includes("crm:view")) return <NoAccess what="the patient CRM" />;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "enquiries";
  const back = `/crm?tab=${tab}`;
  const can = (p: string) => ctx.permissions.includes(p as never);

  return (
    <div className="space-y-4">
      <BrandBanner eyebrow="Patient CRM" title="Enquiries, follow-ups, recall and feedback"><p className="text-xs text-white/70">CRM staff see contact details only, never clinical records.</p></BrandBanner>
      {sp.error && <Alert>{sp.error}</Alert>}
      <Tabs tabs={TABS} active={tab} base="/crm" />
      {tab === "enquiries" && <Enquiries ctx={ctx} back={back} can={can} />}
      {tab === "followups" && <FollowUps ctx={ctx} back={back} can={can} />}
      {tab === "campaigns" && <Campaigns ctx={ctx} back={back} can={can} selected={sp.campaign} />}
      {tab === "feedback" && <Feedback ctx={ctx} back={back} can={can} />}
      {tab === "referrals" && <Referrals ctx={ctx} />}
    </div>
  );
}
type C = Awaited<ReturnType<typeof requireCtx>>;
type Can = (p: string) => boolean;

async function Enquiries({ ctx, back, can }: { ctx: C; back: string; can: Can }) {
  const rows = await listEnquiries(ctx);
  return (
    <>
      <Card title="Enquiries"><Table head={["Name", "Phone", "Source", "Interest", "Status", ""]} empty={rows.length ? undefined : "No enquiries."}>
        {rows.map((e) => <tr key={e._id}><td>{e.name}</td><td dir="ltr" className="text-start">{e.phone}</td><td>{e.source}</td><td>{e.interest}</td><td><Badge tone={e.status === "converted" ? "ok" : e.status === "lost" ? "danger" : "info"}>{e.status}</Badge></td>
          <td>{e.status === "new" && can("crm:update") && <ActionButton action="crm.enquiryUpdate" back={back} hidden={{ id: e._id, status: "contacted" }}>Mark contacted</ActionButton>}{["new", "contacted"].includes(e.status) && can("crm:update") && <ActionButton action="crm.enquiryUpdate" back={back} hidden={{ id: e._id, status: "lost" }} variant="ghost">Lost</ActionButton>}{e.patientId && <a className="ms-2 text-xs text-primary hover:underline" href={`/patients/${e.patientId}`}>Patient</a>}</td></tr>)}</Table></Card>
      {can("crm:create") && <Card title="Log enquiry"><ActionForm action="crm.enquiry" back={back} submit="Save" fields={[{ name: "name", label: "Name", required: true }, { name: "phone", label: "Phone", required: true }, { name: "channel", label: "Channel", type: "select", options: ["phone", "walk-in", "website", "whatsapp", "social"] }, { name: "source", label: "Source", required: true, placeholder: "instagram, referral, search…" }, { name: "interest", label: "Interested in" }, { name: "note", label: "Note" }]} /></Card>}
    </>
  );
}

async function FollowUps({ ctx, back, can }: { ctx: C; back: string; can: Can }) {
  const rows = await listDueFollowUps(ctx, new Date(Date.now() + 7 * 86400000));
  const who = await contactInfo(ctx, rows.map((r) => r.patientId));
  return (
    <>
      <Card title="Due and upcoming (7 days)" action={can("crm:create") && <ActionButton action="crm.missed" back={back}>Create from no-shows</ActionButton>}>
        <Table head={["Patient", "Type", "Due", "Note", ""]} empty={rows.length ? undefined : "Nothing due."}>
          {rows.map((f) => <tr key={f._id}><td>{who.get(f.patientId)?.fullName}<div dir="ltr" className="text-start text-xs text-muted">{who.get(f.patientId)?.phone}</div></td><td className="capitalize">{f.kind.replace("_", " ")}</td><td className="text-xs">{fmtDateTime(f.dueAt)}</td><td className="text-xs">{f.note}</td><td>{can("crm:update") && <ActionButton action="crm.followUpDone" back={back} hidden={{ id: f._id }}>Done</ActionButton>}</td></tr>)}
        </Table>
      </Card>
      {can("crm:create") && <Card title="Add follow-up"><ActionForm action="crm.followUp" back={back} submit="Add" fields={[{ name: "patientId", label: "Patient ID", required: true }, { name: "kind", label: "Type", type: "select", options: ["follow_up", "recall", "chronic_care", "missed_appointment"] }, { name: "due", label: "Due", type: "datetime-local", required: true }, { name: "note", label: "Note" }]} /></Card>}
    </>
  );
}

async function Campaigns({ ctx, back, can, selected }: { ctx: C; back: string; can: Can; selected?: string }) {
  const camps = await tenantCol<{ _id: string; name: string; kind: string; channel: string; lastVisitBeforeDays: number }>(ctx.orgId, "campaigns").find({} as never, { sort: { name: 1 } });
  const audience = selected ? await buildRecallList(ctx, selected).catch(() => null) : null;
  return (
    <>
      <Card title="Campaigns"><Table head={["Name", "Kind", "Channel", "Last visit older than", ""]} empty={camps.length ? undefined : "No campaigns."}>{camps.map((c) => <tr key={c._id}><td>{c.name}</td><td className="capitalize">{c.kind}</td><td>{c.channel}</td><td>{c.lastVisitBeforeDays} days</td><td><a className="text-xs text-primary hover:underline" href={`/crm?tab=campaigns&campaign=${c._id}`}>Preview audience</a></td></tr>)}</Table></Card>
      {audience && <Card title={`Audience: ${audience.candidates.length} consenting patients`} action={<Badge tone="warn">{audience.excludedNoConsent} excluded: no consent</Badge>}><Table head={["Name", "Phone", "Last visit"]} empty="No eligible patients.">{audience.candidates.map((c) => <tr key={c.id}><td>{c.fullName}</td><td dir="ltr" className="text-start">{c.phone}</td><td className="text-xs">{c.lastVisit ? fmtDateTime(c.lastVisit) : "—"}</td></tr>)}</Table><p className="mt-2 text-xs text-muted">Contact details only. Marketing campaigns include only patients with explicit marketing consent.</p></Card>}
      {can("crm:create") && <Card title="New campaign"><ActionForm action="crm.campaign" back={back} submit="Create" fields={[{ name: "name", label: "Name", required: true }, { name: "kind", label: "Kind", type: "select", options: ["recall", "chronic", "marketing"] }, { name: "channel", label: "Channel", type: "select", options: ["sms", "email", "whatsapp"] }, { name: "days", label: "Last visit older than (days)", type: "number", required: true, defaultValue: 365 }]} /></Card>}
    </>
  );
}

async function Feedback({ ctx, back, can }: { ctx: C; back: string; can: Can }) {
  const [sum, comps] = await Promise.all([satisfactionSummary(ctx), listComplaints(ctx)]);
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="Responses" value={sum.responses} /><Stat label="Average rating (1-5)" value={sum.avgRating.toFixed(2)} /><Stat label="NPS" value={sum.nps === null ? "—" : sum.nps.toFixed(0)} hint={`${sum.npsResponses} survey scores`} /><Stat label="Open complaints" value={comps.filter((c) => c.status !== "resolved").length} tone={comps.some((c) => c.status === "open") ? "warn" : undefined} /></div>
      <Card title="Complaints and service requests"><Table head={["Category", "Description", "Status", ""]} empty={comps.length ? undefined : "None."}>
        {comps.map((c) => <tr key={c._id}><td>{c.category}</td><td className="max-w-md text-xs">{c.description}{c.resolution && <div className="text-ok">Resolution: {c.resolution}</div>}</td><td><Badge tone={c.status === "resolved" ? "ok" : c.status === "open" ? "warn" : "info"}>{c.status}</Badge></td>
          <td>{c.status === "open" && can("crm:update") && <ActionButton action="crm.complaintMove" back={back} hidden={{ id: c._id, to: "investigating" }}>Investigate</ActionButton>}{c.status !== "resolved" && can("crm:update") && <ActionForm inline action="crm.complaintMove" back={back} hidden={{ id: c._id, to: "resolved" }} submit="Resolve" variant="outline" fields={[{ name: "resolution", label: "Resolution", required: true }]} />}</td></tr>)}</Table></Card>
      {can("crm:create") && <div className="grid gap-4 lg:grid-cols-2"><Card title="Record feedback"><ActionForm action="crm.feedback" back={back} submit="Save" fields={[{ name: "rating", label: "Rating 1-5", type: "number", required: true }, { name: "nps", label: "Recommend 0-10", type: "number" }, { name: "comment", label: "Comment", span: 3 }]} /></Card><Card title="File a complaint"><ActionForm action="crm.complaint" back={back} submit="File" fields={[{ name: "category", label: "Category", required: true }, { name: "description", label: "What happened (10+ chars)", type: "textarea", required: true, span: 3 }]} /></Card></div>}
    </>
  );
}

async function Referrals({ ctx }: { ctx: C }) {
  const rows = await referralAnalysis(ctx);
  return <Card title="Referral-source analysis"><Table head={["Source", "Patients", "Enquiries", "Converted", "Conversion"]} empty="No data yet.">{rows.map((r) => <tr key={r.source}><td>{r.source}</td><td>{r.patients}</td><td>{r.enquiries}</td><td>{r.converted}</td><td>{r.conversionPct === null ? "—" : `${r.conversionPct.toFixed(0)}%`}</td></tr>)}</Table></Card>;
}
