import type { ClientSession } from "mongodb";
import { getDb } from "./db/client";

/**
 * Named per-org mutex implemented as a write-conflict point.
 * Every txn that must be serialised calls bumpLock(); concurrent txns then conflict and
 * the driver retries the loser against the winner's committed state.
 */
export async function precreateLock(orgId: string, key: string): Promise<void> {
  const db = await getDb();
  try {
    await db.collection("slot_locks").insertOne({ orgId, key, v: 0 });
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
  }
}

export async function bumpLock(orgId: string, key: string, s: ClientSession): Promise<void> {
  const db = await getDb();
  await db.collection("slot_locks").updateOne({ orgId, key }, { $inc: { v: 1 } }, { session: s });
}
