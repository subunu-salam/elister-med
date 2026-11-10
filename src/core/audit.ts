import type { ClientSession } from "mongodb";
import { getDb } from "./db/client";

export type AuditEvent = {
  orgId: string;
  actorId: string;
  action: string;
  resource: string;
  resourceId: string;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
};

/** Append-only. This module deliberately exports no update/delete. */
export async function audit(s: ClientSession, e: AuditEvent): Promise<void> {
  const db = await getDb();
  await db.collection("audit_log").insertOne({ ...e, at: new Date() }, { session: s });
}
