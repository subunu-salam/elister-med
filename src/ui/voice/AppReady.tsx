"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { BellRing, Bookmark, CheckCircle2, Download, Loader2, Share, X } from "lucide-react";
import { BRAVE_HINT, enableCallsHere, isBrave } from "./DeviceCalls";

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== "undefined") {
  // Chrome / Edge / Android fire this once the app is installable (captured early in layout.tsx); keep it for our own "Install" button.
  const w = window as unknown as { __bip?: InstallEvent };
  if (w.__bip) deferred = w.__bip;
  window.addEventListener("elister:installable", () => { deferred = w.__bip ?? deferred; listeners.forEach((f) => f()); });
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e as InstallEvent; listeners.forEach((f) => f()); });
  window.addEventListener("appinstalled", () => { deferred = null; listeners.forEach((f) => f()); });
}

const KEY = "elister:app-ready-dismissed";
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

/** How to unblock notifications on this exact device (the browser will not ask again once they are blocked). */
function unblockSteps(): string[] {
  const p = platform(), app = standalone();
  if (p === "android") return app
    ? ["Long-press the Elister icon on your home screen → App info.", "Tap Notifications and turn on Allow notifications (and the call/assistant category).", "Come back to Elister and tap Try again."]
    : ["Tap the icon left of the address bar → Permissions (or Site settings) → Notifications → Allow.", "No Notifications option there? Open phone Settings → Apps → Chrome → Notifications and turn them on.", "Come back and tap Try again."];
  if (p === "ios") return ["Open iPhone Settings → Notifications → Elister.", "Turn on Allow Notifications, Sounds and Lock Screen.", "Come back to Elister and tap Try again."];
  if (p === "mac-safari") return ["Safari → Settings → Websites → Notifications → set Elister to Allow.", "Also check macOS System Settings → Notifications → Safari (or Elister) is allowed.", "Tap Try again."];
  return ["Click the icon left of the address bar → Site settings → Notifications → Allow.", "Check your computer allows notifications from the browser (Windows: Settings → System → Notifications; macOS: System Settings → Notifications).", "Click Try again."];
}

/**
 * Shown on every Elister screen until this device can receive the assistant's call like a phone call, in two clear steps:
 *  1. Add Elister to the home screen (Android / Chrome / Edge: one tap or menu steps; iPhone: Share → Add to Home Screen, which Apple requires).
 *  2. Turn on call notifications, so the ringing notification arrives at the scheduled time even when Elister is closed.
 * "Not now" hides it for a day; the Scheduled calls page always has the same controls.
 */
export function AppReady() {
  const path = usePathname();
  const [, force] = useState(0);
  const [calls, setCalls] = useState<"unknown" | "on" | "off" | "blocked" | "na">("unknown");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [hidden, setHidden] = useState(true);
  const [showSteps, setShowSteps] = useState(false);
  const [installed, setInstalled] = useState(false);

  const check = async () => {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) return setCalls("na");
    if (Notification.permission === "denied") return setCalls("blocked");
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    setCalls(sub && Notification.permission === "granted" ? "on" : "off");
  };
  useEffect(() => {
    const f = () => force((n) => n + 1); listeners.add(f);
    setInstalled(standalone());
    try { const t = Number(localStorage.getItem(KEY) ?? 0); setHidden(Date.now() - t < 86400_000); } catch { setHidden(false); }
    void check();
    const onVis = () => { if (document.visibilityState === "visible") void check(); }; // back from phone settings
    document.addEventListener("visibilitychange", onVis);
    return () => { listeners.delete(f); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  const ios = typeof navigator !== "undefined" && isIos();
  const needInstall = !installed && (ios || !!deferred || /android/i.test(typeof navigator !== "undefined" ? navigator.userAgent : ""));
  if (hidden || path?.startsWith("/ai/call") || calls === "unknown" || (calls === "on" && !needInstall && !msg) || (calls === "na" && !needInstall)) return null;

  const install = async () => {
    if (deferred) { await deferred.prompt(); const c = await deferred.userChoice; if (c.outcome === "accepted") { deferred = null; setInstalled(true); } force((n) => n + 1); return; }
    setShowSteps(true);
  };
  const turnOn = async () => {
    if (ios && !installed) { setShowSteps(true); setMsg("On iPhone, add Elister to the Home Screen first, then open it from there."); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await enableCallsHere();
      if (r.status === "on") { setCalls("on"); setMsg("Done. Elister will ring this device at your scheduled time, even when the app is closed."); }
      else if (r.status === "denied") setCalls("blocked");
      else setMsg(r.error ?? (isBrave() ? BRAVE_HINT : "Couldn't turn on calls on this device."));
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const retry = async () => {
    try { const p = await Notification.requestPermission(); if (p === "granted") return void turnOn(); } catch { /* old Safari */ }
    await check();
    if (Notification.permission === "denied") setMsg("Still blocked. Follow the steps above, then tap Try again.");
  };
  const dismiss = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch { /* ignore */ } setHidden(true); };
  const steps = STEPS[platform()];
  const Step = ({ n, done, title, children }: { n: number; done: boolean; title: string; children?: React.ReactNode }) => (
    <li className="flex gap-3">
      <span className={`grid size-7 shrink-0 place-items-center rounded-full text-xs font-bold ${done ? "bg-[#1fbf75] text-white" : "bg-white text-[#0b3558]"}`}>{done ? <CheckCircle2 size={15} /> : n}</span>
      <div className="min-w-0 flex-1"><div className={`text-sm font-semibold ${done ? "text-white/60 line-through" : ""}`}>{title}</div>{!done && children}</div>
    </li>
  );

  return (
    <div className="fixed inset-0 z-[950] grid place-items-center bg-black/60 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Set up Elister on this device">
    <div className="relative max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-3xl border border-white/10 bg-[#0b3558] p-5 text-white shadow-2xl">
      <button onClick={dismiss} className="absolute end-2 top-2 grid size-9 place-items-center rounded-full text-white/70 hover:bg-white/10" aria-label="Do it later"><X size={18} /></button>
      <div className="flex items-start gap-3 pe-8">
        <img src="/brand/icon-192.png" alt="" className="size-11 shrink-0 rounded-2xl bg-white" />
        <div className="min-w-0">
          <div className="text-lg font-semibold">Set up Elister on this device</div>
          <p className="mt-0.5 text-sm text-white/75">Two quick steps, so your AI assistant can ring you with its daily report at your scheduled time, even when the app is closed.</p>
        </div>
      </div>
      <ol className="mt-3 space-y-3">
        {needInstall || installed ? (
          <Step n={1} done={installed} title={ios ? "Add Elister to your Home Screen" : "Add Elister to your home screen"}>
            {showSteps && <ol className="mt-1.5 list-decimal space-y-1 ps-4 text-[13px] text-white/80">{steps.map((x) => <li key={x}>{x}</li>)}</ol>}
            <button onClick={() => void install()} className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-[#0b3558] sm:w-auto">
              {ios ? <Share size={16} /> : <Download size={16} />}{deferred ? "Add to home screen" : showSteps ? "Follow the steps above" : "Show me how"}
            </button>
          </Step>
        ) : null}
        <Step n={needInstall || installed ? 2 : 1} done={calls === "on"} title="Turn on call notifications">
          {calls === "blocked" ? (
            <>
              <p className="mt-1 text-[13px] text-white/80">Notifications are blocked for Elister on this device, so the browser can&apos;t ask again. To allow them:</p>
              <ol className="mt-1.5 list-decimal space-y-1 ps-4 text-[13px] text-white/80">{unblockSteps().map((x) => <li key={x}>{x}</li>)}</ol>
              <button onClick={() => void retry()} className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#1fbf75] px-4 py-2.5 text-sm font-semibold text-white sm:w-auto"><BellRing size={16} />Try again</button>
            </>
          ) : calls === "na" ? (
            <p className="mt-1 text-[13px] text-white/80">{ios ? "Available after you open Elister from the Home Screen." : "This browser can't receive notifications. Try Chrome, Edge or Safari."}</p>
          ) : (
            <button onClick={() => void turnOn()} disabled={busy} className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#1fbf75] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 sm:w-auto">{busy ? <Loader2 size={16} className="animate-spin" /> : <BellRing size={16} />}Turn on notifications</button>
          )}
        </Step>
      </ol>
      {msg && <p className="mt-3 rounded-2xl bg-white/10 p-3 text-sm">{msg}</p>}
      <button onClick={dismiss} className="mt-4 w-full rounded-xl border border-white/25 px-4 py-2.5 text-sm font-semibold text-white/90 hover:bg-white/10">
        {calls === "on" ? "Continue to Elister" : "Do it later"}
      </button>
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
