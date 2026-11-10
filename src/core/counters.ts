import type { ClientSession } from "mongodb";
import { getDb } from "./db/client";

/** Atomic per-org sequence. Safe under concurrency (single findOneAndUpdate with $inc). */
export async function nextSeq(orgId: string, key: string, s?: ClientSession): Promise<number> {
  const db = await getDb();
  const doc = await db.collection("counters").findOneAndUpdate(
    { orgId, key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after", session: s },
  );
  return doc!.seq as number;
}
