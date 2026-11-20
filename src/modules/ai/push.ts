import "server-only";
import { createPrivateKey, createHash, sign } from "node:crypto";
import { tenantCol } from "@/core/db";
import { AppError } from "@/core/errors";
import type { Ctx } from "@/core/rbac/authorize";
import { applyDemoDefaults } from "@/core/demo-env";

applyDemoDefaults(); // demo deployments get their push keys automatically

/**
 * Web Push for the assistant's "incoming call", with no extra packages.
 *
 * We send an EMPTY push (no payload, so no message encryption is needed) signed with VAPID. The service worker (public/sw.js) wakes up,
 * asks /api/ai/call/pending who is calling and why, and shows the ringing notification with Answer / Decline. Nothing about the
 * clinic travels through Google/Apple/Mozilla push servers: they only see that "something happened".
 *
 * Keys: run `npx tsx scripts/vapid-keys.ts` once and set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (mailto: or https: URL).
 */
type Sub = { _id: string; userId: string; endpoint: string; ua?: string; at: Date; lastOkAt?: Date };
const subs = (orgId: string) => tenantCol<Sub>(orgId, "push_subscriptions");

export const pushPublicKey = () => process.env.VAPID_PUBLIC_KEY ?? "";
export const pushConfigured = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

const b64u = (b: Buffer) => b.toString("base64url");

/** ES256 JWT for the push service of this endpoint. */
export function vapidJwt(endpoint: string, now = Math.floor(Date.now() / 1000)): string {
  const pub = Buffer.from(pushPublicKey(), "base64url");
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY must be an uncompressed P-256 key (base64url, 65 bytes)");
  const key = createPrivateKey({ format: "jwk", key: { kty: "EC", crv: "P-256", d: process.env.VAPID_PRIVATE_KEY!, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
  const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: now + 12 * 3600, sub: process.env.VAPID_SUBJECT || "mailto:admin@devxpert.ae" })));
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64u(sig)}`;
}

export async function saveSubscription(ctx: Ctx, input: { endpoint?: unknown; ua?: unknown }) {
  if (typeof input.endpoint !== "string" || !/^https:\/\//.test(input.endpoint) || input.endpoint.length > 1000) throw new AppError("VALIDATION", "Invalid push subscription");
  const _id = createHash("sha256").update(input.endpoint).digest("hex").slice(0, 32);
  await subs(ctx.orgId).updateOne({ _id } as never, { $set: { userId: ctx.userId, endpoint: input.endpoint, ua: typeof input.ua === "string" ? input.ua.slice(0, 200) : undefined, at: new Date() } } as never, undefined, { upsert: true });
}
export async function removeSubscription(ctx: Ctx, endpoint: string) {
  await subs(ctx.orgId).deleteMany({ userId: ctx.userId, endpoint } as never);
}
export async function deviceCount(orgId: string, userId: string) { return subs(orgId).count({ userId } as never); }

/** Rings every device this person has enabled. Returns how many push services accepted it; dead subscriptions are removed. */
export async function ringDevices(orgId: string, userId: string): Promise<number> {
  if (!pushConfigured()) return 0;
  const list = await subs(orgId).find({ userId } as never, { limit: 20 });
  let ok = 0;
  await Promise.all(list.map(async (s) => {
    try {
      const r = await fetch(s.endpoint, {
        method: "POST",
        headers: { Authorization: `vapid t=${vapidJwt(s.endpoint)}, k=${pushPublicKey()}`, TTL: "3600", Urgency: "high", Topic: "elister-call", "Content-Length": "0" },
        signal: AbortSignal.timeout(10000),
      });
      if (r.status === 404 || r.status === 410) await subs(orgId).deleteMany({ _id: s._id } as never);
      else if (r.ok) { ok++; await subs(orgId).updateOne({ _id: s._id } as never, { $set: { lastOkAt: new Date() } } as never); }
      else {
        const body = (await r.text()).slice(0, 200);
        console.error("push rejected", r.status, body);
        // Registered with an old key (VapidPkHashMismatch) or otherwise permanently refused: drop it; the app re-registers on next open.
        if (r.status === 400 || r.status === 403 || /VapidPkHashMismatch|UnauthorizedRegistration|InvalidRegistration/i.test(body)) await subs(orgId).deleteMany({ _id: s._id } as never);
      }
    } catch (e) { console.error("push failed", e); }
  }));
  return ok;
}
