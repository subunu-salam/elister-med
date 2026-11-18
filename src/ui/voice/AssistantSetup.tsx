"use client";
import { useState } from "react";
import { BellRing, Check, Loader2, Lock, Phone } from "lucide-react";
import { SECTION_KEYS, SECTION_LABEL, type Lang, type SectionKey } from "@/modules/ai/brief-core";
import { ringHere } from "./CallListener";
import { DeviceCalls } from "./DeviceCalls";

export type Prefs = { enabled: boolean; callTime: string; days: number[]; lang: Lang; sections: SectionKey[]; lockedBy?: string };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * "Your personal assistant" settings: turn on the call on this phone or computer, choose when Elister calls and which parts of the
 * day it reports on, and a "Call me now" button for trying it (and for demos).
 */
export function AssistantSetup({ initial, allowed }: { initial: Prefs; allowed: SectionKey[] }) {
  const [p, setP] = useState(initial);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = !!initial.lockedBy;

  const callMe = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/ai/call/now", { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not place the call");
      // With push the phone rings (and this tab too, via the service worker). Without it, ring right here.
      if (!j.devices) setTimeout(() => ringHere({ title: j.preview.title, body: j.preview.body }), 1200);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const save = async (next: Prefs) => {
    setP(next); setSaving("saving"); setErr(null);
    try {
      const r = await fetch("/api/ai/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setP(j); setSaving("saved"); setTimeout(() => setSaving("idle"), 1500);
    } catch (e) { setErr((e as Error).message); setSaving("idle"); }
  };
  const toggleSection = (k: SectionKey) => { const has = p.sections.includes(k); const s = has ? p.sections.filter((x) => x !== k) : SECTION_KEYS.filter((x) => x === k || p.sections.includes(x)); if (s.length) void save({ ...p, sections: s }); };
  const toggleDay = (d: number) => { const days = p.days.includes(d) ? p.days.filter((x) => x !== d) : [...p.days, d].sort(); void save({ ...p, days }); };

  return (
    <section id="assistant-settings" className="rounded-3xl border border-border bg-surface p-5 shadow-card">
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid size-11 place-items-center rounded-2xl brand-grad text-white"><Phone size={20} /></span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Your personal assistant&apos;s call</h2>
          <p className="text-sm text-muted">Elister calls you every day with the summary, then stays on the line for your questions.</p>
        </div>
        <button onClick={() => void callMe()} disabled={busy} className="inline-flex items-center gap-2 rounded-xl brand-grad px-4 py-2.5 text-sm font-semibold text-white shadow-lg transition hover:-translate-y-0.5 disabled:opacity-60">{busy ? <Loader2 size={16} className="animate-spin" /> : <BellRing size={16} />}Call me now</button>
      </div>

      {err && <p className="mt-3 rounded-xl bg-warn/10 p-3 text-sm">{err}</p>}

      {/* this device */}
      <div className="mt-4"><DeviceCalls compact /></div>

      {/* schedule + content */}
      <fieldset disabled={locked} className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="space-y-3">
          <label className="flex items-center justify-between gap-3 text-sm"><span className="font-medium">Daily call</span>
            <input type="checkbox" checked={p.enabled} onChange={(e) => void save({ ...p, enabled: e.target.checked })} className="size-5 accent-[var(--primary)]" /></label>
          <label className="flex items-center justify-between gap-3 text-sm"><span>Time</span>
            <input type="time" value={p.callTime} step={300} onChange={(e) => void save({ ...p, callTime: e.target.value })} className="rounded-xl border border-border bg-surface-2 px-3 py-1.5" /></label>
          <div className="text-sm"><div className="mb-1.5">Days</div><div className="flex gap-1">{DAYS.map((d, i) => <button type="button" key={d} onClick={() => toggleDay(i)} className={`flex-1 rounded-lg py-1.5 text-xs font-semibold ${p.days.includes(i) ? "bg-primary text-primary-fg" : "bg-surface-2 text-muted"}`}>{d}</button>)}</div></div>
          <label className="flex items-center justify-between gap-3 text-sm"><span>Language</span>
            <select value={p.lang} onChange={(e) => void save({ ...p, lang: e.target.value as Lang })} className="rounded-xl border border-border bg-surface-2 px-3 py-1.5"><option value="en">English</option><option value="ml">മലയാളം (Malayalam)</option></select></label>
          <p className="text-xs text-muted">Calls after 3 pm (Dubai) report on that day; earlier calls report on the day before. <a href="/ai/schedule" className="font-medium text-primary">Open scheduled calls →</a></p>
        </div>
        <div>
          <div className="mb-1.5 text-sm font-medium">What should the report cover?</div>
          <div className="space-y-1.5">
            {SECTION_KEYS.map((k) => {
              const ok = allowed.includes(k);
              return (
                <label key={k} className={`flex cursor-pointer items-start gap-2.5 rounded-xl border p-2.5 text-sm transition ${p.sections.includes(k) && ok ? "border-primary/50 bg-primary/5" : "border-border"} ${ok ? "" : "cursor-not-allowed opacity-45"}`}>
                  <input type="checkbox" className="mt-0.5 accent-[var(--primary)]" checked={p.sections.includes(k) && ok} disabled={!ok} onChange={() => toggleSection(k)} />
                  <span><span className="font-medium">{SECTION_LABEL[k].en}</span><span className="block text-xs text-muted">{ok ? SECTION_LABEL[k].hint : "Not included in your access"}</span></span>
                </label>
              );
            })}
          </div>
        </div>
      </fieldset>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted">
        {locked ? <><Lock size={12} />These settings are managed by your administrator.</> : saving === "saving" ? <><Loader2 size={12} className="animate-spin" />Saving…</> : saving === "saved" ? <><Check size={12} className="text-ok" />Saved</> : "Changes save automatically."}
      </p>
    </section>
  );
}
