import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { clsx } from "clsx";
import { AlertTriangle, CheckCircle2, Info, Lock, TrendingDown, TrendingUp } from "lucide-react";

export const cn = clsx;

export function Card({ title, action, children, className, flush }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={cn("overflow-hidden rounded-2xl border border-border bg-surface shadow-card", className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-border/70 px-5 py-3.5">
          <h2 className="flex items-center gap-2.5 text-sm font-semibold tracking-tight"><span aria-hidden className="h-4 w-1 rounded-full accent-grad" />{title}</h2>
          {action}
        </header>
      )}
      <div className={flush ? "" : "p-5"}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone, icon, trend }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "ok" | "warn" | "danger"; icon?: ReactNode; trend?: { pct: number | null; goodWhen?: "up" | "down" } }) {
  const t = trend && trend.pct !== null ? trend : null;
  const good = t ? (t.goodWhen === "down" ? t.pct! <= 0 : t.pct! >= 0) : true;
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border bg-surface p-4 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-[var(--shadow-pop)]">
      <span aria-hidden className={cn("absolute inset-x-0 top-0 h-0.5", tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warn" : tone === "ok" ? "bg-ok" : "brand-grad")} />
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
        {icon && <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-primary/15 to-teal/15 text-primary">{icon}</span>}
      </div>
      <div className={cn("mt-2 text-[26px] font-semibold leading-none tracking-tight tabular-nums", tone === "ok" && "text-ok", tone === "warn" && "text-warn", tone === "danger" && "text-danger")}>{value}</div>
      <div className="mt-2 flex min-h-5 items-center gap-2 text-xs text-muted">
        {t && <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium", good ? "bg-ok/12 text-ok" : "bg-danger/12 text-danger")}>{t.pct! >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}{Math.abs(t.pct!).toFixed(1)}%</span>}
        {hint}
      </div>
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "danger" | "info" }) {
  const t = { neutral: "bg-surface-2 text-muted", ok: "bg-ok/12 text-ok", warn: "bg-warn/14 text-warn", danger: "bg-danger/12 text-danger", info: "bg-primary/12 text-primary" }[tone];
  return <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium", t)}><span aria-hidden className="size-1.5 rounded-full bg-current opacity-80" />{children}</span>;
}

const field = "w-full rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm text-fg shadow-[inset_0_1px_0_rgba(255,255,255,.4)] transition placeholder:text-muted/70 hover:border-primary/40 focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary/15 disabled:opacity-60";
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cn(field, p.className)} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cn(field, "pe-8", p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cn(field, "min-h-24", p.className)} />;

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-semibold text-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Button({ variant = "primary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "outline" }) {
  const v = {
    primary: "brand-grad text-white shadow-[0_8px_18px_-8px_rgba(11,74,126,.7)] hover:brightness-110",
    ghost: "text-fg hover:bg-surface-2",
    outline: "border border-border bg-surface text-fg hover:border-primary/50 hover:bg-surface-2",
    danger: "bg-danger text-white shadow-[0_8px_18px_-10px_rgba(192,57,43,.8)] hover:brightness-110",
  }[variant];
  return <button {...p} className={cn("inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50", v, className)} />;
}

export function Table({ head, children, empty }: { head: string[]; children: ReactNode; empty?: string }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border/80">
      <table className="w-full text-sm">
        <thead className="tint">
          <tr className="text-start">
            {head.map((h) => (
              <th key={h} className="whitespace-nowrap px-3.5 py-2.5 text-start text-[11px] font-semibold uppercase tracking-wider text-muted">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-t [&>tr]:border-border/70 [&>tr]:transition-colors [&>tr:hover]:bg-primary/[0.045] [&>tr>td]:px-3.5 [&>tr>td]:py-2.5">{children}</tbody>
      </table>
      {empty && <p className="border-t border-border/70 px-3 py-8 text-center text-sm text-muted">{empty}</p>}
    </div>
  );
}

export function Alert({ tone = "danger", children }: { tone?: "danger" | "ok" | "warn"; children: ReactNode }) {
  const t = { danger: "border-danger/30 bg-danger/8 text-danger", ok: "border-ok/30 bg-ok/8 text-ok", warn: "border-warn/35 bg-warn/10 text-warn" }[tone];
  const Icon = tone === "ok" ? CheckCircle2 : tone === "warn" ? Info : AlertTriangle;
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm", t)}>
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function PageHeader({ title, sub, actions, eyebrow }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="page-in mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-primary-strong dark:text-fg">{title}</h1>
        {sub && <p className="mt-1 max-w-3xl text-sm text-muted">{sub}</p>}
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </div>
  );
}

export const Skeleton = ({ className }: { className?: string }) => <div className={cn("skeleton h-4", className)} aria-hidden />;
export const aed = (v: string | number) => `AED ${Number(v).toLocaleString("en-AE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function NoAccess({ what = "this page" }: { what?: string }) {
  return (
    <div className="mx-auto max-w-md pt-16 text-center" role="alert">
      <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary"><Lock size={24} /></div>
      <h1 className="text-lg font-semibold">Access restricted</h1>
      <p className="mt-1 text-sm text-muted">Your role does not have permission to view {what}. Ask an administrator if you need access.</p>
    </div>
  );
}

export function Tabs({ tabs, active, base = "" }: { tabs: { key: string; label: string }[]; active: string; base?: string }) {
  return (
    <nav className="mb-1 inline-flex max-w-full flex-wrap gap-1 rounded-xl bg-surface-2 p-1" aria-label="Sections">
      {tabs.map((t) => (
        <a key={t.key} href={`${base}?tab=${t.key}`} aria-current={t.key === active ? "page" : undefined}
          className={cn("rounded-lg px-3.5 py-1.5 text-sm transition-all", t.key === active ? "bg-surface font-semibold text-primary-strong shadow-sm ring-1 ring-primary/15 [box-shadow:inset_0_-2px_0_var(--teal)]" : "text-muted hover:text-fg")}>{t.label}</a>
      ))}
    </nav>
  );
}

/** Horizontal bars with a brand gradient. Values are plain numbers; `display` is the label shown. */
export function BarList({ rows, empty = "No data in this period." }: { rows: { label: string; value: number; display: string }[]; empty?: string }) {
  if (!rows.length) return <p className="text-sm text-muted">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="space-y-3.5">
      {rows.map((r) => (
        <li key={r.label} className="text-sm">
          <div className="mb-1.5 flex justify-between gap-3"><span className="truncate font-medium">{r.label}</span><span className="tabular-nums text-muted">{r.display}</span></div>
          <div className="h-2.5 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`${r.label}: ${r.display}`}><div className="h-full rounded-full brand-grad transition-[width] duration-700" style={{ width: `${Math.max(3, (r.value / max) * 100)}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

const DONUT = ["#0b4a7e", "#0090c0", "#00a0a0", "#3bb8d0", "#7fd6e6", "#5b7a99"];
/** Accessible donut chart with a legend. */
export function Donut({ parts, centre }: { parts: { label: string; value: number; display: string }[]; centre?: ReactNode }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return <p className="text-sm text-muted">No data in this period.</p>;
  const R = 42, C = 2 * Math.PI * R;
  const arcs = parts.map((p, i) => ({ ...p, i, len: (p.value / total) * C, start: parts.slice(0, i).reduce((x, q) => x + (q.value / total) * C, 0) }));
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative size-36 shrink-0">
        <svg viewBox="0 0 100 100" className="size-full -rotate-90" role="img" aria-label="Share by category">
          <circle cx="50" cy="50" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="13" />
          {arcs.map((p) => <circle key={p.label} cx="50" cy="50" r={R} fill="none" stroke={DONUT[p.i % DONUT.length]} strokeWidth="13" strokeDasharray={`${Math.max(0, p.len - 1.5)} ${C}`} strokeDashoffset={-p.start} strokeLinecap="butt" />)}
        </svg>
        <div className="absolute inset-0 grid place-items-center text-center text-xs text-muted">{centre}</div>
      </div>
      <ul className="min-w-40 flex-1 space-y-2 text-sm">
        {parts.map((p, i) => <li key={p.label} className="flex items-center justify-between gap-3"><span className="flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ background: DONUT[i % DONUT.length] }} />{p.label}</span><span className="tabular-nums text-muted">{p.display}</span></li>)}
      </ul>
    </div>
  );
}
