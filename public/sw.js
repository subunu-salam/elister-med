/* Elister service worker: the personal assistant's incoming call.
 * The server sends an empty web push. We ask the app who is calling, then show a ringing notification with Answer / Decline.
 * If an Elister tab is open, it also gets a message so it can show the full-screen incoming-call screen with the ringtone. */
const CALL_TAG = "elister-call";
const RING = [600, 250, 600, 250, 600, 900, 600, 250, 600, 250, 600]; // phone-style vibration (Android)

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let info = { title: "Elister · Your personal AI assistant", body: "Your daily report is ready. Tap to answer.", ymd: "" };
    try {
      const r = await fetch("/api/ai/call/pending", { credentials: "include", cache: "no-store" });
      if (r.ok) info = Object.assign(info, await r.json());
    } catch (_) { /* offline: generic text */ }
    const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of tabs) c.postMessage({ type: "elister-call", info });
    await self.registration.showNotification("📞 Incoming call · Elister AI", {
      body: info.body,
      tag: CALL_TAG,
      renotify: true,
      requireInteraction: true,
      silent: false,
      vibrate: RING,
      icon: "/brand/icon-192.png",
      badge: "/brand/badge-96.png",
      data: { url: "/ai/call?answer=1", ymd: info.ymd },
      actions: [
        { action: "answer", title: "📞 Answer" },
        { action: "decline", title: "Decline" },
      ],
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "decline") {
    event.waitUntil(fetch("/api/ai/call/decline", { method: "POST", credentials: "include" }).catch(() => null));
    return;
  }
  const url = event.action === "answer" ? "/ai/call?answer=1" : "/ai/call";
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of tabs) {
      if ("focus" in c) { await c.focus(); if ("navigate" in c) return c.navigate(url); }
    }
    return self.clients.openWindow(url);
  })());
});
