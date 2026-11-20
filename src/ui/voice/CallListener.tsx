"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Phone, PhoneOff } from "lucide-react";
import { startRingtone, stopRingtone } from "./ringtone";

type Info = { title: string; body: string };
export const RING_EVENT = "elister:ring";
/** Rings the full-screen incoming call in this tab (used when push is not set up, and for demos). */
export function ringHere(info: Info) { window.dispatchEvent(new CustomEvent(RING_EVENT, { detail: info })); }

/** Registers the service worker once, so this device can receive the assistant's call. */
export async function registerSw(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try { return await navigator.serviceWorker.register("/sw.js", { scope: "/" }); } catch { return null; }
}

/**
 * Mounted on every page. When the assistant calls and Elister is open, the system notification is joined by a full-screen
 * incoming-call card with the caller tune, like a phone call. Answer opens the call screen; Decline dismisses it.
 */
export function CallListener() {
  const router = useRouter();
  const [call, setCall] = useState<Info | null>(null);

  useEffect(() => {
    // Keep this device's push registration matching the server's current key, without asking anything:
    // if notifications are already allowed, (re)subscribe silently. Fixes "VapidPkHashMismatch" after keys change.
    void registerSw().then(async () => {
      try {
        if (!("Notification" in window) || Notification.permission !== "granted") return;
        const { enableCallsHere } = await import("./DeviceCalls");
        await enableCallsHere();
      } catch { /* the setup pop-up still offers it */ }
    });
    const onSw = (e: MessageEvent) => { if (e.data?.type === "elister-call") setCall(e.data.info as Info); };
    const onLocal = (e: Event) => setCall((e as CustomEvent<Info>).detail);
    navigator.serviceWorker?.addEventListener("message", onSw);
    window.addEventListener(RING_EVENT, onLocal);
    // "Call me back in 30 minutes": if Elister is open when the time comes, ring here too (push rings it when closed).
    let cb: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (cb) clearTimeout(cb);
      try {
        const at = Number(localStorage.getItem("elister:callback") ?? 0);
        if (at > Date.now() - 10 * 60_000) cb = setTimeout(() => { localStorage.removeItem("elister:callback"); setCall({ title: "Elister · Your personal AI assistant", body: "Calling you back with today's update, as you asked." }); }, Math.max(0, at - Date.now()));
      } catch { /* storage unavailable */ }
    };
    arm();
    window.addEventListener("elister:callback-set", arm);
    return () => {
      if (cb) clearTimeout(cb);
      window.removeEventListener("elister:callback-set", arm); navigator.serviceWorker?.removeEventListener("message", onSw); window.removeEventListener(RING_EVENT, onLocal); };
  }, []);

  useEffect(() => {
    if (!call) return;
    // Elister is open but not on screen (another tab, minimised): also raise the system's incoming-call notification.
    if (document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted") {
      void navigator.serviceWorker?.getRegistration().then((reg) => reg?.showNotification("📞 Incoming call · Elister AI", {
        body: call.body, tag: "elister-call", requireInteraction: true, icon: "/brand/icon-192.png", badge: "/brand/badge-96.png",
        data: { url: "/ai/call?answer=1" }, actions: [{ action: "answer", title: "📞 Answer" }, { action: "decline", title: "Decline" }],
      } as NotificationOptions & { renotify?: boolean; vibrate?: number[] }));
    }
    void startRingtone();
    const t = setTimeout(() => setCall(null), 45000); // stops ringing after 45 s, like a missed call
    return () => { clearTimeout(t); stopRingtone(); };
  }, [call]);

  if (!call) return null;
  const answer = async () => {
    setCall(null);
    const reg = await navigator.serviceWorker?.getRegistration();
    (await reg?.getNotifications({ tag: "elister-call" }))?.forEach((n) => n.close());
    router.push("/ai/call?answer=1");
  };
  const decline = () => { setCall(null); void fetch("/api/ai/call/decline", { method: "POST" }).catch(() => null); };

  return createPortal(
    <div className="call-overlay" role="alertdialog" aria-label="Incoming call from Elister AI" onClick={() => void startRingtone()}>
      <div className="call-card">
        <div className="call-avatar is-ringing"><span className="call-avatar-core">E</span><span className="call-wave" /><span className="call-wave w2" /><span className="call-wave w3" /></div>
        <p className="mt-6 text-xs font-semibold uppercase tracking-[0.25em] text-white/60">Incoming call</p>
        <h2 className="mt-1 text-2xl font-semibold text-white">Elister AI</h2>
        <p className="text-sm text-white/70">Your personal assistant</p>
        <p className="mx-auto mt-4 max-w-xs text-sm text-white/80">{call.body}</p>
        <div className="mt-10 flex items-center justify-center gap-16">
          <div className="text-center"><button onClick={decline} className="call-btn bg-[#e5484d]" aria-label="Decline"><PhoneOff size={26} /></button><div className="mt-2 text-xs text-white/70">Decline</div></div>
          <div className="text-center"><button onClick={() => void answer()} className="call-btn call-btn-answer bg-[#1fbf75]" aria-label="Answer"><Phone size={26} /></button><div className="mt-2 text-xs text-white/70">Answer</div></div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
