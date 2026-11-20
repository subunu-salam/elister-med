/* Elister service worker: the personal assistant's incoming call.
 * The server sends an empty web push. We ask the app who is calling, then show a ringing notification with Answer / Decline.
 * If an Elister tab is open, it also gets a message so it can show the full-screen incoming-call screen with the ringtone. */
const CALL_TAG = "elister-call";
const RING_TIMES = 6, RING_GAP_MS = 5000;
let ringing = false;
const RING = [600, 250, 600, 250, 600, 900, 600, 250, 600, 250, 600]; // phone-style vibration (Android)

const SHELL = "elister-shell-v2";
const OFFLINE = "/brand/icon-192.png";
self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/manifest.webmanifest", OFFLINE, "/brand/badge-96.png"])).catch(() => null)); });
// Navigations go to the network; if the device is offline, show a small "you're offline" page instead of the browser's error.
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Elister</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;font-family:system-ui;background:#0b3558;color:#fff;text-align:center"><div><img src="/brand/icon-192.png" width="72" style="border-radius:18px;background:#fff"><h1 style="font-size:20px">You are offline</h1><p style="opacity:.75">Elister will reconnect when the internet is back.</p><button onclick="location.reload()" style="padding:12px 20px;border:0;border-radius:12px;font-weight:600">Try again</button></div>',
    { headers: { "content-type": "text/html; charset=utf-8" } })));
});
// Browsers occasionally rotate the push subscription; re-register it so the daily call keeps ringing.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    try {
      const old = event.oldSubscription && event.oldSubscription.options;
      if (!old || !old.applicationServerKey) return;
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: old.applicationServerKey });
      await fetch("/api/push", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
    } catch (_) { /* the app re-subscribes next time it is opened */ }
  })());
});
self.addEventListener("activate", (e) => e.waitUntil((async () => { for (const k of await caches.keys()) if (k !== SHELL) await caches.delete(k); await self.clients.claim(); })()));

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let info = { title: "Elister · Your personal AI assistant", body: "Your daily report is ready. Tap to answer.", ymd: "" };
    try {
      const r = await fetch("/api/ai/call/pending", { credentials: "include", cache: "no-store" });
      if (r.ok) info = Object.assign(info, await r.json());
    } catch (_) { /* offline: generic text */ }
    const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of tabs) c.postMessage({ type: "elister-call", info });
    ringing = true;
    const show = () => self.registration.showNotification("📞 Incoming call · Elister AI", opts);
    const opts = {
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
    };
    await show();
    // Ring like a phone: re-alert (sound + vibration) every few seconds for about 30 s, until answered, declined or swiped away.
    for (let i = 1; i <= RING_TIMES && ringing; i++) {
      await new Promise((r) => setTimeout(r, RING_GAP_MS));
      const open = await self.registration.getNotifications({ tag: CALL_TAG });
      if (!ringing || !open.length) break;
      await show();
    }
    ringing = false;
  })());
});

self.addEventListener("notificationclose", () => { ringing = false; });
self.addEventListener("notificationclick", (event) => {
  ringing = false;
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
