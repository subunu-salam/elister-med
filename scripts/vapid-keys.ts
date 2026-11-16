/** Prints a VAPID key pair for web push (the assistant's incoming call). Run once: npx tsx scripts/vapid-keys.ts */
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pub = publicKey.export({ format: "jwk" }) as { x: string; y: string };
const priv = privateKey.export({ format: "jwk" }) as { d: string };
const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")]).toString("base64url");
console.log(`VAPID_PUBLIC_KEY=${raw}\nVAPID_PRIVATE_KEY=${priv.d}\nVAPID_SUBJECT=mailto:admin@devxpert.ae`);
