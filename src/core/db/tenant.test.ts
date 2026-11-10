import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDb, closeClient, tenantCol, withTransaction, ensureIndexes } from "./index";
import { newId } from "../ids";

const A = "orgA", B = "orgB";
beforeAll(async () => { await ensureIndexes(); });
afterAll(async () => { await closeClient(); });

describe("tenantCol", () => {
  it("never returns another org's doc", async () => {
    const id = newId();
    await tenantCol<{ _id: string; name: string }>(A, "t_docs").insertOne({ _id: id, name: "x" });
    expect(await tenantCol(B, "t_docs").findOne({ _id: id } as any)).toBeNull();
    expect((await tenantCol(A, "t_docs").findOne({ _id: id } as any))?.name).toBe("x");
    expect(await tenantCol(B, "t_docs").count({})).toBe(0);
  });
  it("injects orgId on insert and ignores caller-supplied orgId", async () => {
    const id = newId();
    await tenantCol<any>(A, "t_docs").insertOne({ _id: id, orgId: B } as any);
    const raw = await (await getDb()).collection<any>("t_docs").findOne({ _id: id } as any);
    expect(raw?.orgId).toBe(A);
  });
  it("update cannot cross orgs", async () => {
    const id = newId();
    await tenantCol<any>(A, "t_docs").insertOne({ _id: id, v: 1 });
    const r = await tenantCol<any>(B, "t_docs").updateOne({ _id: id } as any, { $set: { v: 2 } });
    expect(r.matchedCount).toBe(0);
  });
  it("transaction rolls back", async () => {
    const id = newId();
    await expect(withTransaction(async (s) => {
      await tenantCol<any>(A, "t_docs").insertOne({ _id: id }, s);
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(await tenantCol(A, "t_docs").findOne({ _id: id } as any)).toBeNull();
  });
});
