"use client";
import { useEffect, useState } from "react";
import { BellRing, Bookmark, CheckCircle2, Download, Loader2, Share, X } from "lucide-react";
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

type Platform = "ios" | "android" | "mac-safari" | "firefox" | "chromium" | "other";
function platform(): Platform {
  const ua = navigator.userAgent;
  if (isIos()) return "ios";
  if (/android/i.test(ua)) return "android";
  if (/firefox/i.test(ua)) return "firefox";
  if (/safari/i.test(ua) && !/chrome|chromium|edg/i.test(ua)) return "mac-safari";
  if (/chrome|chromium|edg/i.test(ua)) return "chromium";
  return "other";
}
const STEPS: Record<Platform, string[]> = {
  ios: ["Open Elister in Safari (iOS 16.4 or later).", "Tap Share, then Add to Home Screen, then Add.", "Open Elister from the Home Screen icon and tap Turn on calls. iPhone only delivers notifications to apps added to the Home Screen."],
  android: ["Tap Install Elister below, or the browser menu ⋮ → Install app / Add to Home screen.", "Open Elister from its icon and tap Turn on calls, then Allow."],
  "mac-safari": ["In Safari choose File → Add to Dock (macOS Sonoma or later).", "Open Elister from the Dock and tap Turn on calls, then Allow."],
  firefox: ["Firefox can't install web apps, but notifications still work: press Ctrl/⌘ + D to bookmark Elister.", "Tap Turn on calls and Allow. Keep Firefox running in the background to receive calls."],
  chromium: ["Click Install Elister below, or the install icon at the right of the address bar (Chrome / Edge).", "Open Elister from the Start menu, Dock or desktop and tap Turn on calls, then Allow."],
  other: ["Bookmark this page (Ctrl/⌘ + D) or add it to your home screen from the browser menu.", "Tap Turn on calls and Allow notifications."],
};

/** Always-available card (Scheduled calls page): install / bookmark Elister and turn on notifications, with steps for this exact device. */
export function InstallAppCard() {
  const [, force] = useState(0);
  const [plat, setPlat] = useState<Platform | null>(null);
  const [installed, setInstalled] = useState(false);
  const [calls, setCalls] = useState<"on" | "off" | "blocked" | "na">("na");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    const f = () => force((n) => n + 1); listeners.add(f);
    setPlat(platform()); setInstalled(standalone());
    void (async () => {
      if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
      if (Notification.permission === "denied") return setCalls("blocked");
      const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
      setCalls(sub && Notification.permission === "granted" ? "on" : "off");
    })();
    return () => { listeners.delete(f); };
  }, []);
  if (!plat) return null;
  const install = async () => { if (!deferred) return; await deferred.prompt(); if ((await deferred.userChoice).outcome === "accepted") { deferred = null; setInstalled(true); } force((n) => n + 1); };
  const turnOn = async () => {
    setBusy(true); setMsg(null);
    try { const r = await enableCallsHere(); if (r.status === "on") setCalls("on"); else if (r.status === "denied") setCalls("blocked"); else setMsg(r.error ?? (isBrave() ? BRAVE_HINT : "Couldn't turn on calls on this device.")); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const needsHome = plat === "ios" && !installed;
  return (
    <section className="rounded-3xl border border-border bg-surface p-4 shadow-card sm:p-5" aria-label="Install Elister on this device">
      <div className="flex items-start gap-3">
        <img src="/brand/icon-192.png" alt="" className="size-11 shrink-0 rounded-2xl border border-border bg-white" />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Keep Elister on this device</h2>
          <p className="text-sm text-muted">Install or bookmark Elister so your assistant can ring you with a notification on desktop, Android and iPhone, even when the tab is closed.</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 ${installed ? "bg-emerald-500/15 text-emerald-600" : "bg-surface-2 text-muted"}`}>{installed ? <CheckCircle2 size={13} /> : <Bookmark size={13} />}{installed ? "Installed as an app" : "Not installed"}</span>
        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 ${calls === "on" ? "bg-emerald-500/15 text-emerald-600" : "bg-surface-2 text-muted"}`}><BellRing size={13} />{calls === "on" ? "Notifications on" : calls === "blocked" ? "Notifications blocked" : calls === "na" ? (needsHome ? "Add to Home Screen first" : "Not supported here") : "Notifications off"}</span>
      </div>
      {!installed && <ol className="mt-3 list-decimal space-y-1 ps-5 text-sm">{STEPS[plat].map((x) => <li key={x}>{x}</li>)}</ol>}
      {calls === "blocked" && <p className="mt-3 rounded-xl bg-surface-2 p-3 text-sm">Notifications are blocked for this site. Open the site settings (icon left of the address bar, or Settings → Notifications → Elister on a phone), set Notifications to Allow, then reload.</p>}
      {msg && <p className="mt-3 rounded-xl bg-surface-2 p-3 text-sm">{msg}</p>}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        {!installed && deferred && <button onClick={() => void install()} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-fg"><Download size={16} />Install Elister</button>}
        {!installed && needsHome && <span className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm"><Share size={16} />Share → Add to Home Screen</span>}
        {calls === "off" && <button onClick={() => void turnOn()} disabled={busy} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#1fbf75] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{busy ? <Loader2 size={16} className="animate-spin" /> : <BellRing size={16} />}Turn on calls</button>}
      </div>
    </section>
  );
}
