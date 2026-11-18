"use client";
import { useEffect, useState } from "react";
import { BellRing, Check, Loader2, Smartphone } from "lucide-react";
import { registerSw, ringHere } from "./CallListener";

type Status = "checking" | "on" | "off" | "denied" | "unsupported" | "ios-install";

function b64ToBytes(b64: string) {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

/** Subscribes this browser/phone to the assistant's calls. Returns the new status. */
export async function enableCallsHere(): Promise<{ status: Status; error?: string }> {
  if (isIos() && !isStandalone()) return { status: "ios-install" };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return { status: "unsupported" };
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { status: "denied" };
  const reg = await registerSw();
  if (!reg) return { status: "unsupported" };
  const cfg = (await fetch("/api/push").then((r) => r.json())) as { configured: boolean; publicKey: string };
  if (!cfg.configured) return { status: "off", error: "Push isn't set up on the server yet (VAPID keys)." };
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // a subscription made with an older key can't receive pushes: replace it
  if (sub && sub.options.applicationServerKey) {
    const cur = new Uint8Array(sub.options.applicationServerKey as ArrayBuffer), want = b64ToBytes(cfg.publicKey);
    if (cur.length !== want.length || cur.some((v, i) => v !== want[i])) { await sub.unsubscribe(); sub = null; }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.publicKey) as BufferSource });
  const r = await fetch("/api/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint, ua: navigator.userAgent }) });
  if (!r.ok) return { status: "off", error: "Couldn't register this device. Try again." };
  return { status: "on" };
}

/**
 * "Calls on this phone": the one switch a person needs so Elister can ring them even when the app is closed, plus a test call.
 * Handles the iPhone rule (only home-screen apps get notifications) and blocked notifications.
 */
export function DeviceCalls({ compact = false }: { compact?: boolean }) {
  const [st, setSt] = useState<Status>("checking");
  const [busy, setBusy] = useState<"" | "on" | "test">("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      if (isIos() && !isStandalone()) return setSt("ios-install");
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return setSt("unsupported");
      if (Notification.permission === "denied") return setSt("denied");
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      setSt(sub && Notification.permission === "granted" ? "on" : "off");
      if (sub) void fetch("/api/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint, ua: navigator.userAgent }) }).catch(() => null);
    })();
  }, []);

  const turnOn = async () => {
    setBusy("on"); setMsg(null);
    try { const r = await enableCallsHere(); setSt(r.status); if (r.error) setMsg(r.error); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(""); }
  };
  const test = async () => {
    setBusy("test"); setMsg(null);
    try {
      const r = await fetch("/api/ai/call/now", { method: "POST" }); const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Couldn't place the call");
      if (j.devices) setMsg(`Calling ${j.devices === 1 ? "your device" : `${j.devices} devices`} now. Lock the phone or switch apps to see the incoming call.`);
      else { setMsg("No device is set up yet, so it's ringing here."); setTimeout(() => ringHere({ title: j.preview.title, body: j.preview.body }), 800); }
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(""); }
  };

  const text: Record<Status, string> = {
    checking: "Checking this device…",
    on: "Elister can ring this device, even when the app is closed.",
    off: "Turn on calls so Elister can ring you at your scheduled time, even when the app is closed.",
    denied: "Notifications are blocked for Elister. Open the browser's site settings (the icon left of the address), allow Notifications, then reload.",
    unsupported: "This browser can't receive calls. On Android use Chrome; on iPhone add Elister to the Home Screen first.",
    "ios-install": "On iPhone, calls only reach apps on the Home Screen: tap Share, then Add to Home Screen, open Elister from the new icon, and turn on calls there.",
  };

  return (
    <section className={`rounded-3xl border ${st === "on" ? "border-ok/30" : "border-primary/40"} bg-surface p-4 shadow-card ${compact ? "" : "sm:p-5"}`}>
      <div className="flex items-start gap-3">
        <span className={`grid size-11 shrink-0 place-items-center rounded-2xl ${st === "on" ? "bg-ok/15 text-ok" : "brand-grad text-white"}`}>{st === "on" ? <Check size={20} /> : <Smartphone size={20} />}</span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">{st === "on" ? "Calls are on for this device" : "Get your calls on this phone"}</h2>
          <p className="mt-0.5 text-sm text-muted">{text[st]}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        {(st === "off") && <button onClick={() => void turnOn()} disabled={!!busy} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl brand-grad px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">{busy === "on" ? <Loader2 size={16} className="animate-spin" /> : <BellRing size={16} />}Turn on calls</button>}
        {(st === "denied") && <button onClick={() => location.reload()} className="flex-1 rounded-xl border border-border px-4 py-3 text-sm font-semibold">I've allowed it, reload</button>}
        <button onClick={() => void test()} disabled={!!busy} className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-border px-4 py-3 text-sm font-semibold disabled:opacity-60">{busy === "test" ? <Loader2 size={16} className="animate-spin" /> : <BellRing size={16} />}Send a test call</button>
      </div>
      {msg && <p className="mt-2 text-xs text-muted">{msg}</p>}
    </section>
  );
}
