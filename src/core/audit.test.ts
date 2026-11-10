import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTransaction, getDb, closeClient, ensureIndexes } from "./db";
import * as auditMod from "./audit";
import { audit } from "./audit";
import { emit } from "./outbox";
import { runOnce } from "./worker";

beforeAll(async () => { await ensureIndexes(); });
afterAll(async () => { await closeClient(); });

describe("audit", () => {
  it("written in transaction and rolled back with it", async () => {
    const db = await getDb();
    const rid = "r-rollback";
    await expect(withTransaction(async (s) => {
      await audit(s, { orgId: "o1", actorId: "u1", action: "x", resource: "t", resourceId: rid });
      throw new Error("fail");
    })).rejects.toThrow();
    expect(await db.collection("audit_log").countDocuments({ resourceId: rid })).toBe(0);
    await withTransaction((s) => audit(s, { orgId: "o1", actorId: "u1", action: "x", resource: "t", resourceId: "r-ok", after: { a: 1 } }));
    expect(await db.collection("audit_log").countDocuments({ resourceId: "r-ok" })).toBe(1);
  });
  it("exposes no update/delete API", () => {
    expect(Object.keys(auditMod).sort()).toEqual(["audit"]);
  });
});

describe("outbox worker", () => {
  it("delivers a pending event once", async () => {
    const seen: string[] = [];
    await withTransaction((s) => emit(s, "o1", "test.ok", { n: 1 }));
    await runOnce({ "test.ok": async (e) => { seen.push(e.type); } });
    await runOnce({ "test.ok": async (e) => { seen.push(e.type); } });
    expect(seen).toEqual(["test.ok"]);
  });
  it("retries then dead-letters", async () => {
    let calls = 0;
    await withTransaction((s) => emit(s, "o1", "test.fail", {}));
    for (let i = 0; i < 6; i++) await runOnce({ "test.fail": async () => { calls++; throw new Error("nope"); } }, { maxAttempts: 3, backoffMs: 0 });
    expect(calls).toBe(3);
    const db = await getDb();
    const doc = await db.collection("outbox").findOne({ type: "test.fail" });
    expect(doc?.status).toBe("dead");
    expect(doc?.attempts).toBe(3);
  });
});
