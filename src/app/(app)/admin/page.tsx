import Link from "next/link";
import { BellRing, Phone, ShieldCheck, UserPlus, Users } from "lucide-react";
import { requireCtx } from "@/lib/session";
import { NoAccess } from "@/ui/kit";
import { MODULES } from "@/core/rbac/modules";
import { ROLE_INFO, adminActivity, isSuperAdmin, listUsers } from "@/modules/admin/service";
import { userNames } from "@/core/auth";

export const metadata = { title: "Control centre" };
const ago = (d: Date | null) => { if (!d) return "never"; const h = (Date.now() - d.getTime()) / 3600000; return h < 1 ? "just now" : h < 24 ? `${Math.floor(h)} h ago` : `${Math.floor(h / 24)} d ago`; };

export default async function AdminPage() {
  const ctx = await requireCtx();
  if (!isSuperAdmin(ctx)) return <NoAccess what="the control centre (super admin only)" />;
  const [people, activity] = await Promise.all([listUsers(ctx), adminActivity(ctx)]);
  const names = await userNames([...new Set(activity.flatMap((a) => [a.actorId, a.resourceId]))]);
  const active = people.filter((p) => p.active);
  const stats = [
    { label: "People with access", value: people.length, icon: Users },
    { label: "Active", value: active.length, icon: ShieldCheck },
    { label: "Personal assistant on", value: active.filter((p) => p.assistant.eligible && p.assistant.enabled).length, icon: Phone },
    { label: "Devices that can ring", value: active.reduce((a, p) => a + p.assistant.devices, 0), icon: BellRing },
  ];

  return (
    <div className="space-y-6">
      <section className="hero-banner page-in rounded-3xl p-6 md:p-8">
        <span aria-hidden className="rings" />
        <div className="relative flex flex-wrap items-end gap-4">
          <div className="flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-100/80">Super admin</p>
            <h1 className="mt-2 text-[28px] font-semibold leading-tight md:text-[34px]">Control centre</h1>
            <p className="mt-2 max-w-xl text-sm text-white/75">Decide who gets in, what they can do, which parts of the business they can see, and who gets a daily call from the personal AI assistant.</p>
          </div>
          <Link href="/admin/users/new" className="inline-flex items-center gap-1.5 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-[#0b3558] shadow-lg transition hover:-translate-y-0.5"><UserPlus size={15} />Add a person</Link>
        </div>
      </section>

      <section className="stagger grid grid-cols-2 gap-4 xl:grid-cols-4">
        {stats.map((s) => <div key={s.label} className="rounded-2xl border border-border bg-surface p-4 shadow-card"><div className="flex items-center gap-2 text-xs text-muted"><s.icon size={14} />{s.label}</div><div className="mt-1 text-2xl font-semibold tabular-nums">{s.value}</div></div>)}
      </section>

      <section className="overflow-hidden rounded-3xl border border-border bg-surface shadow-card">
        <header className="flex items-center justify-between border-b border-border px-5 py-4"><div><h2 className="font-semibold">Who can see what</h2><p className="text-xs text-muted">● can use · ○ switched off by you · blank = not part of their role. Click a person to change it.</p></div></header>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px] text-sm">
            <thead><tr className="text-start text-xs text-muted">
              <th className="px-5 py-3 text-start font-medium">Person</th><th className="px-2 py-3 text-start font-medium">Role</th>
              {MODULES.map((m) => <th key={m.key} className="px-1 py-3 text-center font-medium" title={m.hint}>{m.label.split(" ")[0]}</th>)}
              <th className="px-3 py-3 text-center font-medium">Assistant</th><th className="px-5 py-3 text-end font-medium">Last active</th>
            </tr></thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.userId} className={`border-t border-border transition hover:bg-surface-2 ${p.active ? "" : "opacity-50"}`}>
                  <td className="px-5 py-3"><Link href={`/admin/users/${p.userId}`} className="font-medium hover:text-primary">{p.name}</Link><div className="text-xs text-muted">{p.email}{!p.active && " · deactivated"}</div></td>
                  <td className="px-2 py-3 text-xs">{p.roles.map((r) => ROLE_INFO[r]?.label ?? r).join(", ")}</td>
                  {MODULES.map((m) => <td key={m.key} className="px-1 py-3 text-center">{p.effective.includes(m.key) ? <span className="text-ok">●</span> : p.available.includes(m.key) ? <span className="text-muted">○</span> : ""}</td>)}
                  <td className="px-3 py-3 text-center text-xs">{p.assistant.eligible ? (p.assistant.enabled ? <span className="font-medium text-primary">{p.assistant.callTime}{p.assistant.devices ? ` · ${p.assistant.devices}📱` : ""}</span> : "off") : "—"}</td>
                  <td className="px-5 py-3 text-end text-xs text-muted">{ago(p.lastActive)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-3xl border border-border bg-surface p-5 shadow-card">
        <h2 className="font-semibold">Recent changes</h2>
        <ul className="mt-3 divide-y divide-border text-sm">
          {activity.length === 0 && <li className="py-2 text-muted">No access changes yet.</li>}
          {activity.map((a, i) => <li key={i} className="flex flex-wrap justify-between gap-2 py-2"><span><b>{names.get(a.actorId) || "Someone"}</b> {({ "admin.access": "changed access for", "admin.create_user": "added", "admin.assistant": "set the assistant for", "admin.ring": "rang" } as Record<string, string>)[a.action] ?? a.action} <b>{names.get(a.resourceId) || "a person"}</b></span><span className="text-xs text-muted">{a.at.toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" })}</span></li>)}
        </ul>
      </section>
    </div>
  );
}
