/**
 * Loads the one-year dataset built by `npm run seed:year` into the MongoDB named in .env.local (MONGODB_URI / MONGODB_DB).
 *
 *   npm run seed:year:push            dry run: shows what would be replaced, changes nothing
 *   npm run seed:year:push -- --yes   REPLACES every collection in the cache (same names) in the target database
 *
 * Only collections present in the cache are touched; the rest of the database is left alone. Indexes are re-created afterwards.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { MongoClient, BSON } from "mongodb";

async function main() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB ?? "healthos_dev";
  if (!uri) throw new Error("MONGODB_URI is not set. Copy .env.example to .env.local and fill it in.");
  const dir = path.resolve(".seed-cache/year");
  if (!fs.existsSync(path.join(dir, "_meta.json"))) throw new Error("No cache found. Run `npm run seed:year` first.");
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "_meta.json"), "utf8")) as { collections: string[]; docsTotal: number; end: string };
  const yes = process.argv.includes("--yes");
  const client = await new MongoClient(uri).connect();
  const db = client.db(dbName);
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  const host = new URL(uri.replace("mongodb+srv://", "https://").replace("mongodb://", "http://")).host;
  console.log(`Target: ${host} / ${dbName}`);
  console.log(`Cache : ${meta.collections.length} collections, ${meta.docsTotal} documents, data to ${meta.end}`);
  const clash: string[] = [];
  for (const n of meta.collections) if (existing.has(n)) clash.push(`${n} (${await db.collection(n).estimatedDocumentCount()} docs)`);
  console.log(clash.length ? `These collections already exist and would be REPLACED:\n  ${clash.join("\n  ")}` : "Target has none of these collections; nothing will be replaced.");
  if (!yes) { console.log("\nDry run only. Re-run with --yes to apply."); await client.close(); return; }

  for (const n of meta.collections) {
    if (existing.has(n)) await db.collection(n).drop();
    const col = db.collection(n);
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, `${n}.ejson`)), crlfDelay: Infinity });
    let batch: BSON.Document[] = [], total = 0;
    for await (const line of rl) {
      if (!line) continue;
      batch.push(BSON.EJSON.parse(line, { relaxed: false }) as BSON.Document);
      if (batch.length >= 1000) { await col.insertMany(batch, { ordered: false }); total += batch.length; batch = []; }
    }
    if (batch.length) { await col.insertMany(batch, { ordered: false }); total += batch.length; }
    console.log(`  ${n.padEnd(28)} ${String(total).padStart(8)}`);
  }
  await client.close();
  const { ensureIndexes, closeClient } = await import("../src/core/db");
  await ensureIndexes(); await closeClient();
  console.log("\nDone. Indexes re-created. Run `npm run seed:year:verify` to re-check the books in the target database.");
}
main().catch((e) => { console.error(e); process.exit(1); });
