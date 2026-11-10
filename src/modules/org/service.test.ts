import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { seedOrg, DEMO_ORG_ID } from "./seed";
import { getOrgConfig, createBranch } from "./service";

beforeAll(async () => { await ensureIndexes(); });
afterAll(async () => { await closeClient(); });

const counts = async () => {
  const o: Record<string, number> = {};
  for (const c of ["branches", "departments", "staff", "services", "accounts", "fiscal_periods", "tax_codes"])
    o[c] = await tenantCol(DEMO_ORG_ID, c).count({});
  return o;
};

describe("seed", () => {
  it("is idempotent", async () => {
    await seedOrg();
    const a = await counts();
    await seedOrg();
    expect(await counts()).toEqual(a);
    expect(a.accounts).toBeGreaterThan(30);
    expect(a.fiscal_periods).toBe(24);
  });
  it("org config: Dubai defaults, hospital off, flags tax review", async () => {
    const c = await getOrgConfig(DEMO_ORG_ID);
    expect(c.currency).toBe("AED");
    expect(c.timezone).toBe("Asia/Dubai");
    expect(c.modules.hospital).toBe(false);
    const s = await tenantCol<any>(DEMO_ORG_ID, "services").findOne({ code: "CONS-GP" });
    expect(s?.taxReviewRequired).toBe(true);
  });
  it("duplicate branch code conflicts", async () => {
    await expect(createBranch(DEMO_ORG_ID, { code: "MAIN", name: "x", emirate: "Dubai" })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("other org sees nothing", async () => {
    expect(await tenantCol("other-org", "services").count({})).toBe(0);
  });
});
