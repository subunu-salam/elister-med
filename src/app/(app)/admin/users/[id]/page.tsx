import Link from "next/link";
import { ArrowLeft, BellRing, Check } from "lucide-react";
import { requireCtx } from "@/lib/session";
import { Alert, NoAccess } from "@/ui/kit";
import { SECTION_KEYS, SECTION_LABEL } from "@/modules/ai/brief-core";
import { getUser, isSuperAdmin } from "@/modules/admin/service";
import { AccessFields } from "../../_fields";
import { ringNow, saveAccess, saveAssistant } from "../../actions";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SAVED: Record<string, string> = { access: "Access saved. It applies from the person's next page load.", created: "Person added. Share the email and temporary password with them privately.", assistant: "Assistant settings saved.", rang: "Calling now. Their phone should ring within a few seconds.", rang0: "Report built and an in-app notification sent. They haven't turned on calls on any device yet." };

export default async function AdminUserPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; error?: string }> }) {
  const ctx = await requireCtx();
  if (!isSuperAdmin(ctx)) return <NoAccess what="the control centre (super admin only)" />;
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const u = await getUser(ctx, id);
  const self = id === ctx.userId;

  return (
    <div className="space-y-5">
      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} />Control centre</Link>
      <div className="flex flex-wrap items-center gap-4">
        <span className="grid size-14 place-items-center rounded-2xl brand-grad text-xl font-semibold text-white">{u.name.charAt(0)}</span>
        <div className="flex-1"><h1 className="text-2xl font-semibold">{u.name}{self && <span className="ms-2 text-sm font-normal text-muted">(you)</span>}</h1><p className="text-sm text-muted">{u.email}{u.title ? ` · ${u.title}` : ""}</p></div>
      </div>
      {sp.error && <Alert>{sp.error}</Alert>}
      {sp.saved && SAVED[sp.saved] && <Alert tone="ok"><Check size={14} className="me-1 inline" />{SAVED[sp.saved]}</Alert>}

      <form action={saveAccess} className="space-y-6 rounded-3xl border border-border bg-surface p-5 shadow-card">
        <input type="hidden" name="userId" value={u.userId} />
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex-1 text-sm"><span className="mb-1 block font-medium">Full name</span><input name="name" defaultValue={u.name} required minLength={2} className="w-full rounded-xl border border-border bg-surface-2 px-3 py-2" /><span className="mt-1 block text-xs text-muted">The assistant greets them by first name.</span></label>
          <label className="flex-1 text-sm"><span className="mb-1 block font-medium">Job title (optional)</span><input name="title" defaultValue={u.title} placeholder="e.g. Investor, Group CFO" className="w-full rounded-xl border border-border bg-surface-2 px-3 py-2" /></label>
          <label className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm"><input type="checkbox" name="active" defaultChecked={u.active} disabled={self} className="size-4 accent-[var(--primary)]" />Can sign in</label>
          {self && <input type="hidden" name="active" value="on" />}
        </div>
        <AccessFields roles={u.roles} modules={u.modules} available={u.available} canGrantPlatform={ctx.roles.includes("platform_super_admin")} />
        <div className="flex justify-end"><button className="rounded-xl brand-grad px-5 py-2.5 text-sm font-semibold text-white shadow-lg">Save access</button></div>
      </form>

      <section className="rounded-3xl border border-border bg-surface p-5 shadow-card">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex-1"><h2 className="font-semibold">Personal AI assistant</h2><p className="text-sm text-muted">{u.assistant.eligible ? `When Elister calls ${u.name.split(" ")[0]}, and what the report covers. ${u.assistant.devices ? `${u.assistant.devices} device(s) can ring.` : "No device turned on yet: they turn it on from Personal assistant → Turn on calls."}` : "Not available: the person needs the AI assistant module, the dashboard, and clinical or finance access."}</p></div>
          {u.assistant.eligible && <form action={ringNow}><input type="hidden" name="userId" value={u.userId} /><button className="inline-flex items-center gap-2 rounded-xl border border-primary px-4 py-2 text-sm font-semibold text-primary"><BellRing size={15} />Ring now</button></form>}
        </div>
        {u.assistant.eligible && (
          <form action={saveAssistant} className="mt-4 grid gap-5 md:grid-cols-2">
            <input type="hidden" name="userId" value={u.userId} />
            <div className="space-y-3 text-sm">
              <label className="flex items-center justify-between"><span className="font-medium">Daily call</span><input type="checkbox" name="enabled" defaultChecked={u.prefs.enabled} className="size-5 accent-[var(--primary)]" /></label>
              <label className="flex items-center justify-between"><span>Time (Dubai)</span><input type="time" name="callTime" defaultValue={u.prefs.callTime} step={3600} className="rounded-xl border border-border bg-surface-2 px-3 py-1.5" /></label>
              <div><div className="mb-1.5">Days</div><div className="flex gap-1">{DAYS.map((d, i) => <label key={d} className="flex-1 cursor-pointer rounded-lg bg-surface-2 py-1.5 text-center text-xs font-semibold text-muted has-[:checked]:bg-primary has-[:checked]:text-primary-fg"><input type="checkbox" name="days" value={i} defaultChecked={u.prefs.days.includes(i)} className="sr-only" />{d}</label>)}</div></div>
              <label className="flex items-center justify-between"><span>Language</span><select name="lang" defaultValue={u.prefs.lang} className="rounded-xl border border-border bg-surface-2 px-3 py-1.5"><option value="en">English</option><option value="ml">മലയാളം (Malayalam)</option></select></label>
              <label className="flex items-start gap-2 rounded-xl bg-surface-2 p-3"><input type="checkbox" name="lock" defaultChecked={u.prefs.lockedBy !== undefined && u.prefs.lockedBy !== null} className="mt-0.5 accent-[var(--primary)]" /><span><span className="font-medium">Lock these settings</span><span className="block text-xs text-muted">The person can listen and ask questions but can&apos;t change the schedule or the report&apos;s content.</span></span></label>
            </div>
            <div>
              <div className="mb-1.5 text-sm font-medium">Report covers</div>
              <div className="space-y-1.5">{SECTION_KEYS.map((k) => <label key={k} className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-border p-2.5 text-sm has-[:checked]:border-primary/50 has-[:checked]:bg-primary/5"><input type="checkbox" name="sections" value={k} defaultChecked={u.prefs.sections.includes(k)} className="mt-0.5 accent-[var(--primary)]" /><span><span className="font-medium">{SECTION_LABEL[k].en}</span><span className="block text-xs text-muted">{SECTION_LABEL[k].hint}</span></span></label>)}</div>
              <p className="mt-2 text-xs text-muted">Parts outside the person&apos;s module access are left out automatically.</p>
              <div className="mt-4 flex justify-end"><button className="rounded-xl brand-grad px-5 py-2.5 text-sm font-semibold text-white shadow-lg">Save assistant</button></div>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
