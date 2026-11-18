import { createECDH, hkdfSync } from "node:crypto";

/**
 * Demo mode (ELISTER_DEMO=1): lets a throwaway demo deployment run without hand-made secret keys. Any of AUTH_SECRET,
 * FIELD_ENCRYPTION_KEY, DISPLAY_KEY, KIOSK_KEY, CRON_SECRET and the web-push (VAPID) key pair that is not set is derived (HKDF-SHA256) from MONGODB_URI, so the keys are
 * stable across builds and instances but never stored anywhere. Real deployments must set real keys and leave ELISTER_DEMO unset.
 */
export function applyDemoDefaults(): void {
  if (process.env.ELISTER_DEMO !== "1") return;
  const seed = process.env.MONGODB_URI;
  if (!seed) return;
  const derive = (name: string, len: number) => Buffer.from(hkdfSync("sha256", seed, "elister-demo", name, len));
  process.env.AUTH_SECRET ||= derive("auth-secret", 32).toString("hex");
  process.env.FIELD_ENCRYPTION_KEY ||= derive("field-encryption", 32).toString("base64");
  process.env.DISPLAY_KEY ||= derive("display-key", 16).toString("hex");
  process.env.KIOSK_KEY ||= derive("kiosk-key", 16).toString("hex");
  process.env.CRON_SECRET ||= derive("cron-secret", 24).toString("hex");
  // Web push (the assistant's incoming call): a stable P-256 key pair, so phones that turned on calls keep working across deploys.
  if (!process.env.VAPID_PRIVATE_KEY || !process.env.VAPID_PUBLIC_KEY) {
    const d = derive("vapid-p256", 32);
    const ecdh = createECDH("prime256v1"); ecdh.setPrivateKey(d);
    process.env.VAPID_PRIVATE_KEY = d.toString("base64url");
    process.env.VAPID_PUBLIC_KEY = ecdh.getPublicKey().toString("base64url");
    process.env.VAPID_SUBJECT ||= "mailto:admin@devxpert.ae";
  }
  // On Render the service knows its own address; use it when BETTER_AUTH_URL was not set by hand.
  if (process.env.RENDER_EXTERNAL_URL) process.env.BETTER_AUTH_URL ||= process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "");
}
