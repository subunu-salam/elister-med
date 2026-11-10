/**
 * Sets one password on every user that signs in with email + password, and ends their open sessions.
 * Usage: RESET_PASSWORD=elister123 npx tsx scripts/reset-passwords.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const password = process.env.RESET_PASSWORD;
  if (!password) throw new Error("Set RESET_PASSWORD");
  const { getDb, closeClient } = await import("../src/core/db");
  const { getAuth } = await import("../src/core/auth");
  const ctx = await getAuth().$context;
  const db = await getDb();
  const hash = await ctx.password.hash(password);
  const users = await db.collection("user").find({}, { projection: { _id: 1, id: 1, email: 1 } }).toArray();
  let n = 0;
  for (const u of users) {
    const id = String((u as { id?: string }).id ?? u._id);
    await ctx.internalAdapter.updatePassword(id, hash);
    await db.collection("session").deleteMany({ userId: id });
    n++; console.log("ok", u.email);
  }
  console.log(`Password reset for ${n} users.`);
  await closeClient();
}
main().catch((e) => { console.error(e); process.exit(1); });
