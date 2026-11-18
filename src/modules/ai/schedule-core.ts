/**
 * When the personal assistant calls: pure date logic (no I/O), shared by the scheduler and the "Scheduled calls" screen.
 * Times are in the person's own time zone (prefs.tz, e.g. Asia/Dubai or Asia/Kolkata; default Asia/Dubai, the clinic's zone).
 * A call happens on each chosen weekday at the chosen time, except on skipped dates; a pending "call me back" comes first.
 */
export type CallSchedule = { enabled: boolean; callTime: string; days: number[]; skipDates?: string[]; tz?: string };
export type UpcomingCall = { at: Date; ymd: string; kind: "callback" | "daily" };

export const DEFAULT_TZ = "Asia/Dubai";
export const TZ_CHOICES: { tz: string; label: string }[] = [
  { tz: "Asia/Dubai", label: "Dubai (GST, UTC+4)" },
  { tz: "Asia/Kolkata", label: "India (IST, UTC+5:30)" },
  { tz: "Asia/Riyadh", label: "Saudi Arabia (UTC+3)" },
  { tz: "Asia/Qatar", label: "Qatar (UTC+3)" },
  { tz: "Europe/London", label: "London" },
  { tz: "America/New_York", label: "New York" },
];
export function validTz(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
const zone = (tz?: string) => (validTz(tz) ? tz : DEFAULT_TZ);

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(d: Date, tz?: string): { ymd: string; minutes: number; dow: number } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone(tz), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const ymd = `${p.year}-${p.month}-${p.day}`;
  return { ymd, minutes: Number(p.hour) * 60 + Number(p.minute), dow: ymdDow(ymd) };
}
/** Offset of a zone from UTC at an instant, in minutes. */
function offsetMin(d: Date, tz?: string): number {
  const p = zonedParts(d, tz);
  const asUtc = Date.UTC(Number(p.ymd.slice(0, 4)), Number(p.ymd.slice(5, 7)) - 1, Number(p.ymd.slice(8, 10)), Math.floor(p.minutes / 60), p.minutes % 60);
  return Math.round((asUtc - Math.floor(d.getTime() / 60000) * 60000) / 60000);
}
/** The instant of HH:MM on a calendar date in a time zone. */
export function zonedAt(ymd: string, hhmm: string, tz?: string): Date {
  const guess = new Date(`${ymd}T${hhmm}:00Z`);
  const first = new Date(guess.getTime() - offsetMin(guess, tz) * 60000);
  return new Date(guess.getTime() - offsetMin(first, tz) * 60000); // second pass handles DST edges
}
export const zonedYmd = (d: Date, tz?: string) => zonedParts(d, tz).ymd;

// Dubai helpers kept for existing callers
export const dubaiYmd = (d: Date) => zonedYmd(d, DEFAULT_TZ);
export const dubaiAt = (ymd: string, hhmm: string) => zonedAt(ymd, hhmm, DEFAULT_TZ);

export const ymdDow = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
export const addDaysYmd = (ymd: string, n: number) => new Date(new Date(`${ymd}T12:00:00Z`).getTime() + n * 86400_000).toISOString().slice(0, 10);

/** Does a daily call ring on this date (a date in the schedule's own time zone)? */
export function callsOn(s: CallSchedule, ymd: string): boolean {
  return s.enabled && s.days.includes(ymdDow(ymd)) && !(s.skipDates ?? []).includes(ymd);
}

/**
 * The next calls from `now`: a pending call-back first (if any), then daily calls. dailyCalledToday = today's scheduled call has
 * already rung ("Call me now" and call-backs do not count, so testing during the day never cancels the evening call).
 */
export function upcomingCalls(s: CallSchedule, now: Date, opts: { snoozeUntil?: Date | null; dailyCalledToday?: boolean; calledToday?: boolean; count?: number } = {}): UpcomingCall[] {
  const tz = zone(s.tz);
  const out: UpcomingCall[] = [];
  if (opts.snoozeUntil && opts.snoozeUntil.getTime() > now.getTime() - 5 * 60_000) out.push({ at: opts.snoozeUntil, ymd: zonedYmd(opts.snoozeUntil, tz), kind: "callback" });
  const today = zonedYmd(now, tz);
  const calledToday = opts.dailyCalledToday ?? opts.calledToday ?? false;
  for (let i = 0; i < 60 && out.length < (opts.count ?? 5); i++) {
    const ymd = addDaysYmd(today, i);
    if (!callsOn(s, ymd)) continue;
    const at = zonedAt(ymd, s.callTime, tz);
    if (i === 0 && (calledToday || at.getTime() <= now.getTime())) continue;
    out.push({ at, ymd, kind: "daily" });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Is today's scheduled call due now? (call time passed today, in the person's zone, and not rung yet) */
export function dailyDue(s: CallSchedule, now: Date, dailyCalledToday: boolean): boolean {
  const p = zonedParts(now, s.tz);
  const [h, m] = s.callTime.split(":").map(Number);
  return !dailyCalledToday && callsOn(s, p.ymd) && h * 60 + m <= p.minutes;
}

/** "18:30" → { h12: 6, m: 30, pm: true } and back, for the hours/minutes picker. */
export function split24(t: string) { const h = Number(t.slice(0, 2)), m = Number(t.slice(3, 5)); return { h12: h % 12 || 12, m, pm: h >= 12 }; }
export function join24(h12: number, m: number, pm: boolean) { const h = (h12 % 12) + (pm ? 12 : 0); return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`; }
