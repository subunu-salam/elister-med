/**
 * When the personal assistant calls: pure date logic (Dubai time, no I/O), shared by the scheduler and the "Scheduled calls" screen.
 * A call happens on each chosen weekday at the chosen time, except on skipped dates; a pending "call me back" comes first.
 */
export type CallSchedule = { enabled: boolean; callTime: string; days: number[]; skipDates?: string[] };
export type UpcomingCall = { at: Date; ymd: string; kind: "callback" | "daily" };

const DUBAI = 4 * 3600_000;
export const dubaiYmd = (d: Date) => new Date(d.getTime() + DUBAI).toISOString().slice(0, 10);
export const ymdDow = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
export const addDaysYmd = (ymd: string, n: number) => new Date(new Date(`${ymd}T12:00:00Z`).getTime() + n * 86400_000).toISOString().slice(0, 10);
/** The instant of HH:MM Dubai time on a Dubai calendar date. */
export const dubaiAt = (ymd: string, hhmm: string) => new Date(`${ymd}T${hhmm}:00+04:00`);

/** Does a daily call ring on this date? */
export function callsOn(s: CallSchedule, ymd: string): boolean {
  return s.enabled && s.days.includes(ymdDow(ymd)) && !(s.skipDates ?? []).includes(ymd);
}

/**
 * The next calls from `now`: a pending call-back first (if any), then daily calls. A daily call already placed today (calledToday) or
 * whose time has passed is not repeated today.
 */
export function upcomingCalls(s: CallSchedule, now: Date, opts: { snoozeUntil?: Date | null; calledToday?: boolean; count?: number } = {}): UpcomingCall[] {
  const out: UpcomingCall[] = [];
  if (opts.snoozeUntil && opts.snoozeUntil.getTime() > now.getTime() - 5 * 60_000) out.push({ at: opts.snoozeUntil, ymd: dubaiYmd(opts.snoozeUntil), kind: "callback" });
  const today = dubaiYmd(now);
  for (let i = 0; i < 60 && out.length < (opts.count ?? 5); i++) {
    const ymd = addDaysYmd(today, i);
    if (!callsOn(s, ymd)) continue;
    const at = dubaiAt(ymd, s.callTime);
    if (i === 0 && (opts.calledToday || at.getTime() <= now.getTime())) continue;
    out.push({ at, ymd, kind: "daily" });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** "18:30" → { h12: 6, m: 30, pm: true } and back, for the hours/minutes picker. */
export function split24(t: string) { const h = Number(t.slice(0, 2)), m = Number(t.slice(3, 5)); return { h12: h % 12 || 12, m, pm: h >= 12 }; }
export function join24(h12: number, m: number, pm: boolean) { const h = (h12 % 12) + (pm ? 12 : 0); return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`; }
