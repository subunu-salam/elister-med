import { hkdfSync } from "node:crypto";

/**
 * Demo mode (ELISTER_DEMO=1): lets a throwaway demo deployment run without hand-made secret keys. Any of AUTH_SECRET,
 * FIELD_ENCRYPTION_KEY, DISPLAY_KEY and KIOSK_KEY that is not set is derived (HKDF-SHA256) from MONGODB_URI, so the keys are
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
}
