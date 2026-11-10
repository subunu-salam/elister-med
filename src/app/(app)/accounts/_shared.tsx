import Link from "next/link";
import type { ReactNode } from "react";
import { fromDecimal128 } from "@/core/money";
import { aed, cn } from "@/ui/kit";
import type { ForecastPoint } from "@/modules/accounts/insights-core";

export const m = (d: { toFixed: (n: number) => string }) => aed(d.toFixed(2));
export const d128 = (x: unknown) => m(fromDecimal128(x as never));
export const num = (v: number) => aed(v.toFixed(2));
export const TONE: Record<string, "neutral" | "ok" | "warn" | "danger" | "info"> = {
  draft: "neutral", open: "info", partially_paid: "warn", paid: "ok", void: "danger", sent: "info", accepted: "ok", declined: "danger", converted: "neutral", delivered: "ok",
  active: "ok", paused: "warn", stopped: "neutral", pending_approval: "warn", approved: "info", rejected: "danger",
};
export const LINES_HINT = "One line per row:  Description | qty | unit price | STD, ZERO or EXEMPT | account.  Or use an item:  @SKU | qty  (price and VAT come from Items; add a third value to override the price).";

/** Small "AI" chip so generated content is always labelled. */
export const AiTag = ({ children = "AI" }: { children?: ReactNode }) => (
  <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-[#0a7ba5] to-[#00a0a0] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">✦ {children}</span>
);

/** Circular 0-100 score. */
export function ScoreRing({ score, label }: { score: number; label: string }) {
  const R = 42, C = 2 * Math.PI * R, tone = score >= 80 ? "#00a07a" : score >= 60 ? "#0a7ba5" : score >= 40 ? "#d99a00" : "#c0392b";
  return (
    <div className="relative size-36 shrink-0" role="img" aria-label={`Financial health ${score} out of 100, ${label}`}>
      <svg viewBox="0 0 100 100" className="size-full -rotate-90">
        <circle cx="50" cy="50" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="9" />
        <circle cx="50" cy="50" r={R} fill="none" stroke={tone} strokeWidth="9" strokeLinecap="round" strokeDasharray={`${(score / 100) * C} ${C}`} className="transition-[stroke-dasharray] duration-1000" />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center"><div><div className="text-3xl font-semibold tabular-nums">{score}</div><div className="text-xs text-muted">{label}</div></div></div>
    </div>
  );
}

/** 13-week cash forecast: expected line, confidence band, zero line. Pure SVG, server-rendered. */
export function ForecastChart({ points, opening, compact }: { points: ForecastPoint[]; opening: number; compact?: boolean }) {
  if (!points.length) return <p className="text-sm text-muted">Not enough data to forecast.</p>;
  const W = 640, H = compact ? 150 : 220, P = 28;
  const vals = [opening, ...points.flatMap((p) => [p.low, p.high]), 0];
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const x = (i: number) => P + (i / points.length) * (W - 2 * P);
  const y = (v: number) => H - P - ((v - lo) / span) * (H - 2 * P);
  const line = [`M${x(0)},${y(opening)}`, ...points.map((p, i) => `L${x(i + 1)},${y(p.expected)}`)].join(" ");
  const band = [`M${x(0)},${y(opening)}`, ...points.map((p, i) => `L${x(i + 1)},${y(p.high)}`), ...[...points].reverse().map((p, i) => `L${x(points.length - i)},${y(p.low)}`), "Z"].join(" ");
  const last = points[points.length - 1];
  const fmtK = (v: number) => `${Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + "M" : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(0) + "k" : v.toFixed(0)}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Cash forecast: from ${fmtK(opening)} today to about ${fmtK(last.expected)} in ${points.length} weeks`}>
      <defs><linearGradient id="fc" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#0a7ba5" stopOpacity=".28" /><stop offset="1" stopColor="#0a7ba5" stopOpacity=".04" /></linearGradient></defs>
      {lo < 0 && <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} stroke="#c0392b" strokeDasharray="4 4" strokeWidth="1" />}
      <path d={band} fill="url(#fc)" />
      <path d={line} fill="none" stroke="#0b3558" strokeWidth="2.5" strokeLinejoin="round" />
      {points.map((p, i) => <circle key={p.week} cx={x(i + 1)} cy={y(p.expected)} r="2.5" fill={p.expected < 0 ? "#c0392b" : "#0b3558"}><title>{`Week ${p.week}: expected ${p.expected.toFixed(2)} (range ${p.low.toFixed(0)} to ${p.high.toFixed(0)}); in ${p.inflow.toFixed(0)}, out ${p.outflow.toFixed(0)}`}</title></circle>)}
      <text x={P} y={H - 6} fontSize="10" fill="currentColor" opacity=".6">Today</text>
      <text x={W - P} y={H - 6} fontSize="10" fill="currentColor" opacity=".6" textAnchor="end">Week {points.length}</text>
      <text x={P - 4} y={y(hi) + 4} fontSize="10" fill="currentColor" opacity=".6" textAnchor="end">{fmtK(hi)}</text>
      <text x={P - 4} y={y(lo) + 4} fontSize="10" fill="currentColor" opacity=".6" textAnchor="end">{fmtK(lo)}</text>
    </svg>
  );
}

/** Tiny bar chart for monthly series. */
export function MiniBars({ values, labels }: { values: number[]; labels: string[] }) {
  const max = Math.max(1, ...values.map(Math.abs));
  return (
    <div className="flex h-24 items-end gap-1.5" role="img" aria-label="Monthly net cash movement">
      {values.map((v, i) => (
        <div key={labels[i]} className="flex flex-1 flex-col items-center gap-1">
          <div className={cn("w-full rounded-t", v >= 0 ? "brand-grad" : "bg-danger/70")} style={{ height: `${Math.max(4, (Math.abs(v) / max) * 80)}px` }} title={`${labels[i]}: ${v.toFixed(2)}`} />
          <span className="text-[10px] text-muted">{labels[i]}</span>
        </div>
      ))}
    </div>
  );
}

export const Quick = ({ href, children }: { href: string; children: ReactNode }) => (
  <Link href={href} className="rounded-full border border-border px-3 py-1.5 text-xs hover:bg-surface-2">{children}</Link>
);
