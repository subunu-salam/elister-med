import { dubaiParts } from "@/core/time";

const DUBAI = "+04:00";
const parse = (s: string | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00${DUBAI}`) : undefined);

/** from/to as YYYY-MM-DD (to inclusive in the UI). Defaults to the current Dubai month. */
export function parseRange(sp: { from?: string; to?: string }) {
  const today = dubaiParts(new Date()).ymd;
  const defFrom = `${today.slice(0, 7)}-01`;
  const fromStr = sp.from && parse(sp.from) ? sp.from : defFrom;
  const toStr = sp.to && parse(sp.to) ? sp.to : today;
  const from = parse(fromStr)!;
  const to = new Date(parse(toStr)!.getTime() + 86400000); // exclusive end
  return { from, to, fromStr, toStr };
}
export const todayYmd = () => dubaiParts(new Date()).ymd;
