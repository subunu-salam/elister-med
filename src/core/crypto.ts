import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

function key(): Buffer {
  const b64 = process.env.FIELD_ENCRYPTION_KEY;
  if (!b64) throw new Error("FIELD_ENCRYPTION_KEY is not set (see .env.example)");
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error("FIELD_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return k;
}

/** AES-256-GCM field encryption. Output: iv.tag.ciphertext (base64). */
export function encryptField(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
}

export function decryptField(enc: string): string {
  const [iv, tag, ct] = enc.split(".").map((p) => Buffer.from(p, "base64"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

/** Deterministic keyed hash for equality lookup of an encrypted identifier (blind index). */
export function blindIndex(plain: string): string {
  return createHmac("sha256", key()).update(plain).digest("hex");
}
