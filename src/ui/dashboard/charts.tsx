import Link from "next/link";
import type { ReactNode } from "react";

/** Paired daily bars: this week (navy) next to the same weekday last week (teal). Pure CSS, server-rendered, with a text alternative. */
export function PairBars({ days }: { days: { label: string; value: number; previous: number; today?: boolean }[] }) {
  const top = Math.max(1, ...days.flatMap((d) => [d.value, d.previous]));
  const nice = Math.max(4, Math.ceil(top / 4) * 4);
  const ticks = [nice, nice * 0.75, nice * 0.5, nice * 0.25, 0];
  const h = (v: number) => `${v ? Math.max(3, (v / nice) * 100) : 0}%`;
  return (
    <div className="flex gap-3" role="img" aria-label={days.map((d) => `${d.label}: ${d.value} this week, ${d.previous} last week`).join("; ")}>
      <div className="flex h-56 flex-col justify-between pb-6 text-end text-[11px] tabular-nums text-muted">{ticks.map((t) => <span key={t}>{Math.round(t)}</span>)}</div>
      <div className="relative flex h-56 flex-1 items-end justify-around gap-2">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-6 top-0 flex flex-col justify-between">{ticks.map((t) => <div key={t} className="border-t border-dashed border-border" />)}</div>
        {days.map((d) => (
          <div key={d.label} className="group relative z-10 flex h-full flex-1 flex-col items-center justify-end">
            <div className="flex h-[calc(100%-24px)] items-end gap-1">
              <div className="bar-fill w-3 rounded-t-md transition-[height] duration-700 sm:w-3.5" style={{ height: h(d.value) }} title={`${d.label}: ${d.value} this week`} />
              <div className="bar-prev w-3 rounded-t-md transition-[height] duration-700 sm:w-3.5" style={{ height: h(d.previous) }} title={`${d.label}: ${d.previous} last week`} />
            </div>
            <span className={`mt-1.5 text-xs ${d.today ? "font-semibold text-primary" : "text-muted"}`}>{d.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const RING = ["var(--primary)", "var(--accent)", "#0b3558", "#7fd3df"];
/** Donut with an overall figure in the centre and a legend underneath. */
export function RingTotal({ parts, total, caption }: { parts: { label: string; value: number }[]; total: ReactNode; caption: string }) {
  const sum = parts.reduce((a, p) => a + p.value, 0);
  const R = 40, C = 2 * Math.PI * R;
  let start = 0;
  return (
    <div>
      <div className="relative mx-auto size-44">
        <svg viewBox="0 0 100 100" className="size-full -rotate-90" role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(", ")}>
          <circle cx="50" cy="50" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="13" />
          {sum > 0 && parts.map((p, i) => { const len = (p.value / sum) * C; const el = <circle key={p.label} cx="50" cy="50" r={R} fill="none" stroke={RING[i % RING.length]} strokeWidth="13" strokeDasharray={`${Math.max(0, len - 1)} ${C}`} strokeDashoffset={-start} />; start += len; return el; })}
        </svg>
        <div className="absolute inset-0 grid place-items-center text-center"><div><div className="text-xs text-muted">Overall</div><div className="text-2xl font-semibold tabular-nums">{total}</div><div className="text-[11px] text-muted">{caption}</div></div></div>
      </div>
      <ul className="mt-4 space-y-2 text-sm">
        {parts.map((p, i) => <li key={p.label} className="flex items-center justify-between gap-3"><span className="flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ background: RING[i % RING.length] }} />{p.label}</span><span className="tabular-nums text-muted">{p.value}{sum ? ` · ${Math.round((p.value / sum) * 100)}%` : ""}</span></li>)}
      </ul>
    </div>
  );
}

/** Month calendar (Dubai), today highlighted, days with appointments marked with a dot. */
export function MiniCalendar({ year, month, today, busy }: { year: number; month: number; today: number; busy: Set<number> }) {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const title = new Date(Date.UTC(year, month, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <div>
      <div className="mb-3 flex items-center justify-between"><span className="text-[15px] font-semibold">{title}</span><Link href="/appointments" className="text-xs font-medium text-primary hover:underline">Calendar</Link></div>
      <div className="grid grid-cols-7 gap-y-1 text-center text-[11px]">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <span key={i} className={`pb-1 font-semibold ${i === 0 || i === 6 ? "text-danger/70" : "text-muted"}`}>{d}</span>)}
        {cells.map((d, i) => d === null ? <span key={`b${i}`} /> : (
          <span key={d} className="grid place-items-center">
            <span className={`relative grid size-8 place-items-center rounded-full text-xs tabular-nums ${d === today ? "bg-[var(--btn-bg)] font-semibold text-[var(--btn-fg)]" : "text-fg"}`}>
              {d}{busy.has(d) && d !== today && <span className="absolute bottom-1 size-1 rounded-full bg-accent" />}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
