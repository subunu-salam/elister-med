import type { ClientSession } from "mongodb";
import { getDb } from "./db/client";

export type OutboxEvent = { _id?: unknown; orgId: string; type: string; payload: Record<string, unknown>; attempts: number };

/** Emit inside the same transaction as the state change. */
export async function emit(s: ClientSession, orgId: string, type: string, payload: object): Promise<void> {
  const db = await getDb();
  await db.collection("outbox").insertOne(
    { orgId, type, payload, status: "pending", attempts: 0, nextAttemptAt: new Date(), createdAt: new Date() },
    { session: s },
  );
}
