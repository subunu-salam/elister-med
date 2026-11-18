"use client";
import { useEffect, useState } from "react";
import { BellRing, Download, Loader2, Share, X } from "lucide-react";
import { BRAVE_HINT, enableCallsHere, isBrave } from "./DeviceCalls";

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== "undefined") {
  // Chrome / Edge / Android fire this once the app is installable; keep it for our own "Install" button.
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e as InstallEvent; listeners.forEach((f) => f()); });
  window.addEventListener("appinstalled", () => { deferred = null; listeners.forEach((f) => f()); });
}

const KEY = "elister:app-ready-dismissed";
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

/**
 * Shown on every Elister screen until the device is ready to receive the assistant's call like a phone call:
 *  1. Install Elister as an app (Android / Chrome / Edge: one tap; iPhone: Share → Add to Home Screen, which Apple requires for calls).
 *  2. Turn on calls (notification permission + push), so the incoming-call banner appears even when Elister is closed.
 * Dismissable for three days.
 */
export function AppReady() {
  const [, force] = useState(0);
  const [calls, setCalls] = useState<"unknown" | "on" | "off" | "blocked" | "na">("unknown");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [hidden, setHidden] = useState(true);
  const [iosSteps, setIosSteps] = useState(false);

  useEffect(() => {
    const f = () => force((n) => n + 1); listeners.add(f);
    try { const t = Number(localStorage.getItem(KEY) ?? 0); setHidden(Date.now() - t < 3 * 86400_000); } catch { setHidden(false); }
    void (async () => {
      if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) return setCalls(isIos() && !standalone() ? "off" : "na");
      if (Notification.permission === "denied") return setCalls("blocked");
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      setCalls(sub && Notification.permission === "granted" ? "on" : "off");
    })();
    return () => { listeners.delete(f); };
  }, []);

  const ios = typeof navigator !== "undefined" && isIos();
  const canInstall = !!deferred || (ios && typeof window !== "undefined" && !standalone());
  const needCalls = calls === "off" || calls === "blocked";
  if (hidden || calls === "unknown" || (!canInstall && !needCalls)) return null;

  const install = async () => {
    if (deferred) { await deferred.prompt(); const c = await deferred.userChoice; if (c.outcome === "accepted") deferred = null; force((n) => n + 1); return; }
    setIosSteps(true);
  };
  const turnOn = async () => {
    if (ios && !standalone()) { setIosSteps(true); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await enableCallsHere();
      if (r.status === "on") { setCalls("on"); setMsg("Calls are on. Elister will ring this device at your scheduled time."); }
      else if (r.status === "denied") setCalls("blocked");
      else setMsg(r.error ?? (isBrave() ? BRAVE_HINT : "Couldn't turn on calls on this device."));
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const dismiss = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch { /* ignore */ } setHidden(true); };

  return (
    <div className="app-ready fixed inset-x-3 bottom-3 z-[900] mx-auto max-w-xl rounded-3xl border border-white/10 bg-[#0b3558] p-4 text-white shadow-2xl sm:bottom-5" role="region" aria-label="Get Elister's calls on this device">
      <button onClick={dismiss} className="absolute right-3 top-3 grid size-8 place-items-center rounded-full text-white/70 hover:bg-white/10" aria-label="Not now"><X size={16} /></button>
      <div className="flex items-start gap-3 pe-8">
        <img src="/brand/icon-192.png" alt="" className="size-11 shrink-0 rounded-2xl bg-white" />
        <div className="min-w-0">
          <div className="font-semibold">Get Elister&apos;s calls like a phone call</div>
          <p className="mt-0.5 text-sm text-white/75">
            {canInstall ? "Install Elister on this device, then turn on calls. Your assistant will ring you at your scheduled time, even when Elister is closed." : "Turn on calls so your assistant can ring you at your scheduled time, even when Elister is closed."}
          </p>
        </div>
      </div>
      {iosSteps && (
        <ol className="mt-3 space-y-1 rounded-2xl bg-white/10 p-3 text-sm">
          <li>1. Tap <Share size={14} className="mx-0.5 inline" /> <b>Share</b> at the bottom of Safari.</li>
          <li>2. Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>
          <li>3. Open <b>Elister</b> from your Home Screen and tap <b>Turn on calls</b> there.</li>
        </ol>
      )}
      {calls === "blocked" && <p className="mt-3 rounded-2xl bg-white/10 p-3 text-sm">Notifications are blocked for Elister. Click the icon left of the address bar → Site settings → Notifications → Allow, then reload.</p>}
      {msg && <p className="mt-3 rounded-2xl bg-white/10 p-3 text-sm">{msg}</p>}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        {canInstall && <button onClick={() => void install()} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-semibold text-[#0b3558]"><Download size={16} />{ios ? "Add to Home Screen" : "Install Elister"}</button>}
        {calls === "off" && <button onClick={() => void turnOn()} disabled={busy} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#1fbf75] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">{busy ? <Loader2 size={16} className="animate-spin" /> : <BellRing size={16} />}Turn on calls</button>}
        {calls === "blocked" && <button onClick={() => location.reload()} className="flex-1 rounded-xl border border-white/30 px-4 py-3 text-sm font-semibold">I&apos;ve allowed it, reload</button>}
      </div>
    </div>
  );
}
