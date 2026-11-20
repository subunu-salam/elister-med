"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { BellRing, CalendarDays, Check, ChevronLeft, ChevronRight, Clock, Loader2, Lock, Phone, PhoneForwarded, X } from "lucide-react";
import { addDaysYmd, callsOn, DEFAULT_TZ, join24, split24, TZ_CHOICES, upcomingCalls, ymdDow, zonedYmd, type CallSchedule } from "@/modules/ai/schedule-core";
import { ringHere } from "./CallListener";
import { DeviceCalls } from "./DeviceCalls";
import { InstallAppCard } from "./AppReady";

type Prefs = CallSchedule & { lang: "en" | "ml"; sections: string[]; lockedBy?: string };
type Upcoming = { at: string; ymd: string; kind: "callback" | "daily" };
export type ScheduleData = { prefs: Prefs; snoozeUntil: string | null; calledToday: string | null; answeredToday: string | null; upcoming: Upcoming[] };

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fmtTime = (d: Date, tz: string) => d.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz });
const fmtDay = (ymd: string, today: string) => ymd === today ? "Today" : ymd === addDaysYmd(today, 1) ? "Tomorrow" : new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "Asia/Dubai"; } };

function countdown(ms: number) {
  if (ms <= 0) return "any moment now";
  const m = Math.round(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d >= 1 ? `in ${d} day${d > 1 ? "s" : ""} ${h % 24} h` : h >= 1 ? `in ${h} h ${m % 60} min` : `in ${m} min`;
}

/**
 * "Scheduled calls": when Elister will call, a pending call-back, and the controls to change it (hours and minutes, which weekdays, and a
 * month calendar to skip or restore single dates). Opens after "Call me back in 30 minutes" and from the Personal assistant page.
 */
export function ScheduleScreen({ initial, highlight }: { initial: ScheduleData; highlight?: "callback" }) {
  const [data, setData] = useState(initial);
  const [p, setP] = useState<Prefs>(initial.prefs);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const zone = initial.prefs.tz ?? DEFAULT_TZ;
  const [month, setMonth] = useState(() => zonedYmd(new Date(), zone).slice(0, 7));
  const [busy, setBusy] = useState(false);
  const locked = !!p.lockedBy;
  const tz = p.tz ?? DEFAULT_TZ;                       // the schedule's zone: all times on this screen are in it
  const today = zonedYmd(new Date(now), tz);
  const device = useMemo(localTz, []);
  const tzLabel = (z: string) => TZ_CHOICES.find((c) => c.tz === z)?.label.split(" (")[0] ?? z.split("/").pop()!.replace(/_/g, " ");
  const T = (d: Date) => fmtTime(d, tz);
  const t = split24(p.callTime);

  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(i); }, []);

  // Next calls recomputed locally as settings change, so the screen answers instantly.
  const next = useMemo(() => upcomingCalls(p, new Date(now), { snoozeUntil: data.snoozeUntil ? new Date(data.snoozeUntil) : null, calledToday: !!data.calledToday, count: 6 }), [p, now, data.snoozeUntil, data.calledToday]);
  const first = next[0];

  const save = async (patch: Partial<Prefs>) => {
    const nextP = { ...p, ...patch };
    setP(nextP); setSaving("saving"); setErr(null);
    try {
      const r = await fetch("/api/ai/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(nextP) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not save");
      setP((x) => ({ ...x, ...j })); setSaving("saved"); setTimeout(() => setSaving("idle"), 1500);
    } catch (e) { setErr((e as Error).message); setSaving("idle"); }
  };
  const cancelCallback = async () => {
    setBusy(true);
    try { await fetch("/api/ai/schedule", { method: "DELETE" }); localStorage.removeItem("elister:callback"); window.dispatchEvent(new Event("elister:callback-set")); setData((d) => ({ ...d, snoozeUntil: null })); } finally { setBusy(false); }
  };
  const callNow = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/ai/call/now", { method: "POST" }); const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      if (!j.devices) setTimeout(() => ringHere({ title: j.preview.title, body: j.preview.body }), 800);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const toggleDate = (ymd: string) => {
    if (ymd < today) return;
    const weekdayOn = p.days.includes(ymdDow(ymd));
    if (!weekdayOn) { void save({ days: [...p.days, ymdDow(ymd)].sort() }); return; } // turning on a day-off weekday
    const skip = new Set(p.skipDates ?? []);
    if (skip.has(ymd)) skip.delete(ymd); else skip.add(ymd);
    void save({ skipDates: [...skip].sort() });
  };

  // month grid
  const [yy, mm] = month.split("-").map(Number);
  const firstYmd = `${month}-01`, startDow = ymdDow(firstYmd), daysIn = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const cells: (string | null)[] = [...Array(startDow).fill(null), ...Array.from({ length: daysIn }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`)];
  const shiftMonth = (n: number) => { const d = new Date(Date.UTC(yy, mm - 1 + n, 1)); setMonth(d.toISOString().slice(0, 7)); };
  const sel = "rounded-xl border border-border bg-surface-2 px-3 py-2.5 text-lg font-semibold tabular-nums outline-none focus:border-primary disabled:opacity-60";

  return (
    <div className="space-y-5">
      <Link href="/ai/brief" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ChevronLeft size={14} />Personal assistant</Link>

      {/* next call */}
      <section className="brief-hero page-in relative overflow-hidden rounded-3xl p-5 text-white sm:p-6 md:p-8">
        <span aria-hidden className="brief-glow" />
        <div className="relative flex flex-wrap items-center gap-6">
          <div className={`call-avatar ${first ? "is-ringing" : ""}`} style={{ width: 96, height: 96 }}><span className="call-avatar-core" style={{ width: 80, height: 80, fontSize: 30 }}><Phone size={30} /></span><span className="call-wave" /><span className="call-wave w2" /></div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">{first?.kind === "callback" ? "Call-back booked" : "Next call from Elister"}</p>
            {first ? (
              <>
                <h1 className="mt-1 text-2xl font-semibold sm:text-3xl md:text-4xl">{fmtDay(first.ymd, today)}, {T(first.at)}</h1>
                <p className="mt-1 text-sm text-white/80">{countdown(first.at.getTime() - now)} · {tzLabel(tz)} time{tz !== DEFAULT_TZ ? ` · ${fmtTime(first.at, DEFAULT_TZ)} in Dubai` : ""}</p>
              </>
            ) : <h1 className="mt-1 text-2xl font-semibold">No calls scheduled</h1>}
          </div>
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            {first?.kind === "callback" && <button onClick={() => void cancelCallback()} disabled={busy} className="inline-flex items-center gap-1.5 rounded-xl bg-white/15 px-4 py-2.5 text-sm font-semibold"><X size={15} />Cancel call-back</button>}
            <button onClick={() => void callNow()} disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-[#0b3558] shadow-lg">{busy ? <Loader2 size={15} className="animate-spin" /> : <BellRing size={15} />}Call me now</button>
          </div>
        </div>
        {highlight === "callback" && first?.kind === "callback" && <p className="relative mt-4 rounded-2xl bg-white/10 p-3 text-sm">You asked Elister to call back. It will ring this device at {T(first.at)}. You can change your regular call below.</p>}
      </section>

      <InstallAppCard />
      <DeviceCalls />

      {err && <p className="rounded-2xl bg-warn/10 p-3 text-sm">{err}</p>}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        {/* time + weekdays */}
        <section className="space-y-5 rounded-3xl border border-border bg-surface p-5 shadow-card">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold"><Clock size={17} className="text-primary" />Daily call</h2>
            <label className="flex items-center gap-2 text-sm"><span className="text-muted">{p.enabled ? "On" : "Off"}</span><input type="checkbox" checked={p.enabled} disabled={locked} onChange={(e) => void save({ enabled: e.target.checked })} className="size-5 accent-[var(--primary)]" /></label>
          </div>

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm font-medium">
              <span>Time <span className="font-normal text-muted">({tzLabel(tz)})</span></span>
              <select aria-label="Time zone" value={tz} disabled={locked} onChange={(e) => void save({ tz: e.target.value })} className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs font-normal">
                {[...TZ_CHOICES, ...(TZ_CHOICES.some((c) => c.tz === device) ? [] : [{ tz: device, label: `${device} (this device)` }]), ...(TZ_CHOICES.some((c) => c.tz === tz) || tz === device ? [] : [{ tz, label: tz }])].map((c) => <option key={c.tz} value={c.tz}>{c.label}{c.tz === device ? " · this device" : ""}</option>)}
              </select>
            </div>
            {tz !== device && <button disabled={locked} onClick={() => void save({ tz: device })} className="mb-2 w-full rounded-xl bg-primary/10 px-3 py-2 text-left text-xs text-primary">Your device is set to {tzLabel(device)}. Tap to use {tzLabel(device)} time for your calls.</button>}
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label="Hour" value={t.h12} disabled={locked} onChange={(e) => void save({ callTime: join24(Number(e.target.value), t.m, t.pm) })} className={sel}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
              <span className="text-xl font-semibold text-muted">:</span>
              <select aria-label="Minutes" value={t.m} disabled={locked} onChange={(e) => void save({ callTime: join24(t.h12, Number(e.target.value), t.pm) })} className={sel}>
                {Array.from({ length: 12 }, (_, i) => i * 5).concat(t.m % 5 ? [t.m] : []).sort((a, b) => a - b).map((m) => <option key={m} value={m}>{String(m).padStart(2, "0")}</option>)}
              </select>
              <div className="flex rounded-xl border border-border bg-surface-2 p-1" role="radiogroup" aria-label="AM or PM">
                {[false, true].map((pm) => <button key={String(pm)} role="radio" aria-checked={t.pm === pm} disabled={locked} onClick={() => t.pm !== pm && void save({ callTime: join24(t.h12, t.m, pm) })} className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${t.pm === pm ? "bg-primary text-primary-fg" : "text-muted"}`}>{pm ? "PM" : "AM"}</button>)}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {["07:30", "09:00", "13:00", "18:00", "20:00", "21:30"].map((q) => <button key={q} disabled={locked} onClick={() => void save({ callTime: q })} className={`rounded-full border px-3 py-1 text-xs ${p.callTime === q ? "border-primary bg-primary/10 text-primary" : "border-border text-muted hover:text-fg"}`}>{(() => { const x = split24(q); return `${x.h12}:${String(x.m).padStart(2, "0")} ${x.pm ? "PM" : "AM"}`; })()}</button>)}
            </div>
            <p className="mt-2 text-xs text-muted">After 3 pm (Dubai) the call reports on that day; earlier, on the day before. Test calls with &quot;Call me now&quot; never cancel the scheduled call.</p>
          </div>

          <div>
            <div className="mb-2 text-sm font-medium">Repeat on</div>
            <div className="grid grid-cols-7 gap-1">
              {DOW.map((d, i) => <button key={d} disabled={locked} onClick={() => void save({ days: p.days.includes(i) ? p.days.filter((x) => x !== i) : [...p.days, i].sort() })} className={`rounded-xl py-2 text-xs font-semibold ${p.days.includes(i) ? "bg-primary text-primary-fg" : "bg-surface-2 text-muted"}`}>{d}</button>)}
            </div>
            <div className="mt-2 flex gap-2 text-xs">
              <button disabled={locked} onClick={() => void save({ days: [0, 1, 2, 3, 4, 5, 6] })} className="text-primary">Every day</button>·
              <button disabled={locked} onClick={() => void save({ days: [1, 2, 3, 4, 5, 6] })} className="text-primary">Mon–Sat</button>·
              <button disabled={locked} onClick={() => void save({ days: [1, 2, 3, 4, 5] })} className="text-primary">Weekdays</button>
            </div>
          </div>

          <div>
            <div className="mb-2 text-sm font-medium">Language</div>
            <div className="flex rounded-xl border border-border bg-surface-2 p-1 text-sm font-semibold">
              {(["en", "ml"] as const).map((l) => <button key={l} disabled={locked} onClick={() => p.lang !== l && void save({ lang: l })} className={`flex-1 rounded-lg py-1.5 ${p.lang === l ? "bg-primary text-primary-fg" : "text-muted"}`}>{l === "en" ? "English" : "മലയാളം"}</button>)}
            </div>
          </div>
          <p className="flex items-center gap-1.5 text-xs text-muted">
            {locked ? <><Lock size={12} />Managed by your administrator.</> : saving === "saving" ? <><Loader2 size={12} className="animate-spin" />Saving…</> : saving === "saved" ? <><Check size={12} className="text-ok" />Saved</> : "Changes save automatically."}
            <Link href="/ai/brief#assistant-settings" className="ms-auto text-primary">What the report covers →</Link>
          </p>
        </section>

        {/* calendar + upcoming */}
        <section className="space-y-5 rounded-3xl border border-border bg-surface p-5 shadow-card">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold"><CalendarDays size={17} className="text-primary" />{MONTHS[mm - 1]} {yy}</h2>
            <div className="flex gap-1"><button onClick={() => shiftMonth(-1)} disabled={month <= today.slice(0, 7)} className="grid size-8 place-items-center rounded-lg hover:bg-surface-2 disabled:opacity-30" aria-label="Previous month"><ChevronLeft size={16} /></button><button onClick={() => shiftMonth(1)} className="grid size-8 place-items-center rounded-lg hover:bg-surface-2" aria-label="Next month"><ChevronRight size={16} /></button></div>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-muted">{DOW.map((d) => <div key={d}>{d[0]}</div>)}</div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((ymd, i) => {
              if (!ymd) return <div key={i} />;
              const past = ymd < today, on = callsOn(p, ymd), skipped = (p.skipDates ?? []).includes(ymd), cb = first?.kind === "callback" && first.ymd === ymd;
              return (
                <button key={ymd} disabled={past || locked} onClick={() => toggleDate(ymd)} title={past ? "" : on ? "Tap to skip this day" : skipped ? "Tap to restore" : "Tap to call on this weekday"}
                  className={`relative aspect-square rounded-xl text-sm font-medium transition ${past ? "text-muted/40" : on ? "bg-primary/12 text-fg hover:bg-primary/20" : skipped ? "text-muted line-through hover:bg-surface-2" : "text-muted hover:bg-surface-2"} ${ymd === today ? "ring-2 ring-primary" : ""}`}>
                  {Number(ymd.slice(8))}
                  {!past && on && <span className="absolute bottom-1 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-primary" />}
                  {cb && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-amber-400" />}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted">● call day · tap a date to skip it (or restore it) · <span className="text-amber-500">●</span> call-back</p>

          <div>
            <div className="mb-2 text-sm font-medium">Coming up</div>
            <ul className="divide-y divide-border rounded-2xl border border-border">
              {next.length === 0 && <li className="p-3 text-sm text-muted">Nothing scheduled. Turn on the daily call or pick some days.</li>}
              {next.map((c, i) => (
                <li key={i} className="flex items-center gap-3 p-3 text-sm">
                  {c.kind === "callback" ? <PhoneForwarded size={16} className="text-amber-500" /> : <Phone size={16} className="text-primary" />}
                  <span className="flex-1">{fmtDay(c.ymd, today)}<span className="text-muted"> · {c.kind === "callback" ? "Call-back" : "Daily report"}</span></span>
                  <span className="font-semibold tabular-nums">{T(c.at)}</span>
                  {c.kind === "daily" && !locked && <button onClick={() => toggleDate(c.ymd)} className="text-xs text-muted hover:text-danger">Skip</button>}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      {data.calledToday && <p className="text-center text-xs text-muted">Today&apos;s scheduled call rang at {T(new Date(data.calledToday))}{data.answeredToday ? ` and was answered at ${T(new Date(data.answeredToday))}` : ""}.</p>}
    </div>
  );
}
