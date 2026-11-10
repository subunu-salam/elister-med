const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000; // Asia/Dubai: UTC+4, no DST
const DAY_MS = 24 * 60 * 60 * 1000;

/** Dubai wall-clock parts for an instant. dow: 0 = Sunday. */
export function dubaiParts(d: Date): { dow: number; minutes: number; ymd: string } {
  const l = new Date(d.getTime() + DUBAI_OFFSET_MS);
  return { dow: l.getUTCDay(), minutes: l.getUTCHours() * 60 + l.getUTCMinutes(), ymd: l.toISOString().slice(0, 10) };
}
export const hhmmToMinutes = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

export function dubaiDayRange(date: Date): { start: Date; end: Date } {
  const local = date.getTime() + DUBAI_OFFSET_MS;
  const startLocal = Math.floor(local / DAY_MS) * DAY_MS;
  const start = new Date(startLocal - DUBAI_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}
