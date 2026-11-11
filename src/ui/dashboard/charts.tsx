import type { ReactNode } from "react";

/**
 * Weekly bars like an instrument panel: a gradient bar for this week, a hatched ghost bar behind it for the same day last week,
 * and a dotted plinth. Pure CSS, server-rendered; every bar has a text alternative.
 */
export function WeekBars({ days, max: maxIn }: { days: { label: string; value: number; previous: number; today?: boolean }[]; max?: number }) {
  const top = Math.max(1, maxIn ?? 0, ...days.flatMap((d) => [d.value, d.previous]));
  const nice = Math.ceil(top / 5) * 5 || 5;
  const ticks = [nice, Math.round(nice * 0.75), Math.round(nice * 0.5), Math.round(nice * 0.25), 0];
  return (
    <div className="flex gap-3" role="img" aria-label={days.map((d) => `${d.label}: ${d.value} (last week ${d.previous})`).join("; ")}>
      <div className="flex h-64 flex-col justify-between pb-7 text-end text-[11px] tabular-nums text-muted">{ticks.map((t) => <span key={t}>{t}</span>)}</div>
      <div className="relative flex h-64 flex-1 items-end gap-2 sm:gap-4">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 bottom-7 flex flex-col justify-between">{ticks.map((t) => <div key={t} className="border-t border-dashed border-border" />)}</div>
        {days.map((d) => {
          const h = (v: number) => `${Math.max(v ? 4 : 0, (v / nice) * 100)}%`;
          return (
            <div key={d.label} className="group relative z-10 flex h-full flex-1 flex-col items-center justify-end">
              <div className="relative flex h-[calc(100%-28px)] w-full max-w-14 items-end">
                <div className="bar-hatch absolute inset-x-0 bottom-0 rounded-[10px]" style={{ height: h(d.previous) }} />
                <div className="bar-dots absolute inset-x-0 bottom-0 h-[18%] rounded-b-[10px] opacity-70" />
                <div className={`bar-fill relative mx-auto w-full rounded-[10px] transition-[height] duration-700 ${d.today ? "ring-2 ring-teal/60 ring-offset-2 ring-offset-transparent" : ""}`} style={{ height: h(d.value) }}>
                  <span className="absolute -top-7 left-1/2 -translate-x-1/2 rounded-full bg-[var(--btn-bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--btn-fg)] opacity-0 transition group-hover:opacity-100">{d.value}</span>
                </div>
              </div>
              <span className={`mt-2 text-xs ${d.today ? "font-semibold text-fg" : "text-muted"}`}>{d.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Half-circle gauge with two segments and a big centre figure. */
export function HalfGauge({ a, b, centre, sub }: { a: { label: string; value: number }; b: { label: string; value: number }; centre: ReactNode; sub: string }) {
  const total = a.value + b.value;
  const R = 80, C = Math.PI * R, share = total ? a.value / total : 0;
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-4 text-sm">
        <span className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-[#0a7ba5]" />{a.label} <b className="tabular-nums">{total ? Math.round(share * 100) : 0}%</b></span>
        <span className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-[#28c4e0]" />{b.label} <b className="tabular-nums">{total ? 100 - Math.round(share * 100) : 0}%</b></span>
      </div>
      <div className="relative mx-auto max-w-sm">
        <svg viewBox="0 0 200 112" className="w-full" role="img" aria-label={`${a.label} ${a.value}, ${b.label} ${b.value}`}>
          <defs>
            <linearGradient id="gA" x1="0" x2="1"><stop offset="0" stopColor="#0b3558" /><stop offset="1" stopColor="#0a7ba5" /></linearGradient>
            <linearGradient id="gB" x1="0" x2="1"><stop offset="0" stopColor="#28c4e0" /><stop offset="1" stopColor="#9fe3ef" /></linearGradient>
          </defs>
          <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="var(--surface-2)" strokeWidth="22" strokeLinecap="round" />
          <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="url(#gB)" strokeWidth="22" strokeLinecap="round" />
          <path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="url(#gA)" strokeWidth="22" strokeLinecap="round" strokeDasharray={`${share * C} ${C}`} className="transition-[stroke-dasharray] duration-1000" />
          <path d="M44 100 A56 56 0 0 1 156 100" fill="none" stroke="var(--border)" strokeWidth="1" strokeDasharray="3 4" />
        </svg>
        <div className="absolute inset-x-0 bottom-1 text-center"><div className="text-xs text-muted">{sub}</div><div className="text-[30px] font-semibold leading-tight tabular-nums">{centre}</div></div>
      </div>
    </div>
  );
}
