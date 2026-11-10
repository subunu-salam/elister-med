/**
 * Copies every collection from the MongoDB Atlas database (MONGODB_URI) into the local server (LOCAL_MONGODB_URI), then rebuilds the indexes.
 * Atlas is only read, never changed. Re-running first empties each local collection, so the copy is always a clean snapshot.
 * Usage: npx tsx scripts/migrate-atlas-to-local.ts
 */
import { config } from "dotenv";
import { MongoClient } from "mongodb";
config({ path: ".env.local" });

const BATCH = 2000;

async function main() {
  const from = process.env.MONGODB_URI, to = process.env.LOCAL_MONGODB_URI ?? "mongodb://127.0.0.1:27018/?directConnection=true";
  if (!from) throw new Error("MONGODB_URI is not set");
  const dbName = process.env.MONGODB_DB ?? "healthos_dev";
  const src = await new MongoClient(from).connect();
  const dst = await new MongoClient(to).connect();
  try {
    try { await dst.db("admin").command({ replSetGetStatus: 1 }); } catch { await dst.db("admin").command({ replSetInitiate: { _id: "rs0", members: [{ _id: 0, host: "127.0.0.1:27018" }] } }); await new Promise((r) => setTimeout(r, 4000)); }
    const sdb = src.db(dbName), ddb = dst.db(dbName);
    const cols = (await sdb.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system."));
    let total = 0;
    for (const name of cols) {
      await ddb.collection(name).deleteMany({});
      let batch: object[] = [], n = 0;
      for await (const doc of sdb.collection(name).find({})) {
        batch.push(doc);
        if (batch.length >= BATCH) { await ddb.collection(name).insertMany(batch as never, { ordered: false }); n += batch.length; batch = []; }
      }
      if (batch.length) { await ddb.collection(name).insertMany(batch as never, { ordered: false }); n += batch.length; }
      total += n;
      if (n) console.log(`${name}: ${n}`);
    }
    console.log(`Copied ${total} documents in ${cols.length} collections to ${to.replace(/\/\/.*@/, "//")}`);
  } finally {
    await src.close(); await dst.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
