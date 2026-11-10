/**
 * Local dev/E2E runner that needs no Atlas: starts an in-memory MongoDB replica set (transactions work),
 * seeds the synthetic demo org, then starts Next.js. Data is discarded when you stop it.
 * For real development against Atlas, create .env.local and use `npm run dev` + `npm run seed`.
 */
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const port = process.env.PORT ?? "3000";
const mode = process.argv[2] === "start" ? "start" : "dev";

async function main() {
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  Object.assign(process.env, {
    MONGODB_URI: rs.getUri(),
    MONGODB_DB: "healthos_dev",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "local-dev-secret-local-dev-secret-0123456789",
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? `http://localhost:${port}`,
    FIELD_ENCRYPTION_KEY: process.env.FIELD_ENCRYPTION_KEY ?? Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
    DISPLAY_KEY: process.env.DISPLAY_KEY ?? "local-display-key",
  });
  const cache = path.resolve(".seed-cache/year");
  if (process.argv.includes("--year") && fs.existsSync(path.join(cache, "_meta.json"))) {
    // load the one-year dataset built by `npm run seed:year` (instant; data is discarded when you stop)
    const { MongoClient, BSON } = await import("mongodb");
    const c = await new MongoClient(rs.getUri()).connect();
    const db = c.db("healthos_dev");
    for (const f of fs.readdirSync(cache).filter((x) => x.endsWith(".ejson"))) {
      const docs = fs.readFileSync(path.join(cache, f), "utf8").split("\n").filter(Boolean).map((l) => BSON.EJSON.parse(l, { relaxed: false }) as import("mongodb").Document);
      for (let i = 0; i < docs.length; i += 1000) await db.collection(f.replace(".ejson", "")).insertMany(docs.slice(i, i + 1000));
    }
    await c.close();
    const { ensureIndexes } = await import("../src/core/db");
    await ensureIndexes();
    console.log("Loaded one-year dataset from .seed-cache/year");
  } else {
    const { seedAll } = await import("./seed");
    await seedAll({ activity: true });
  }
  const nextBin = path.resolve("node_modules/next/dist/bin/next");
  const next = spawn(process.execPath, [nextBin, mode, "-p", port], { env: process.env, stdio: "inherit" });
  const stop = async () => { next.kill(); await rs.stop(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  next.on("exit", stop);
  console.log(`\nElister Med local: http://localhost:${port}  (admin@demo.local / Demo-Only-Pass-2026!)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
