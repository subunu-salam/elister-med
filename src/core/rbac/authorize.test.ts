import { describe, it, expect } from "vitest";
import { ROLE_PERMISSIONS, ROLE_KEYS, permissionsFor } from "./roles";
import { assertPermission, type Ctx } from "./authorize";

const ctx = (roles: string[]): Ctx => ({
  userId: "u", orgId: "o", branchId: "b", roles: roles as any, permissions: permissionsFor(roles as any),
});
const can = (roles: string[], p: any) => { try { assertPermission(ctx(roles), p); return true; } catch (e: any) { if (e.code === "FORBIDDEN") return false; throw e; } };

describe("RBAC matrix", () => {
  it("defines all 18 roles", () => { expect(ROLE_KEYS).toHaveLength(18); });
  it("receptionist cannot see ledger", () => {
    expect(can(["receptionist"], "ledger:view")).toBe(false);
    expect(can(["receptionist"], "patients:create")).toBe(true);
  });
  it("doctor cannot post to ledger but can sign notes", () => {
    expect(can(["doctor"], "ledger:create")).toBe(false);
    expect(can(["doctor"], "emr:approve")).toBe(true);
  });
  it("nurse cannot sign notes", () => { expect(can(["nurse"], "emr:approve")).toBe(false); });
  it("auditor is read-only everywhere", () => {
    for (const p of ROLE_PERMISSIONS.auditor) expect(p.endsWith(":create") || p.endsWith(":update") || p.endsWith(":approve")).toBe(false);
    expect(can(["auditor"], "audit:audit")).toBe(true);
  });
  it("marketing-type roles never reach clinical data", () => {
    for (const r of ["receptionist", "accountant", "hr_manager", "inventory_manager"]) expect(can([r], "emr:view")).toBe(false);
  });
  it("patient portal user has no staff permissions", () => {
    expect(can(["patient_portal_user"], "patients:update")).toBe(false);
    expect(can(["patient_portal_user"], "ledger:view")).toBe(false);
  });
  it("union across multiple roles", () => {
    expect(can(["receptionist", "accountant"], "ledger:view")).toBe(true);
  });
  it("no role ever gets ledger update (immutable)", () => {
    for (const r of ROLE_KEYS) expect(ROLE_PERMISSIONS[r]).not.toContain("ledger:update");
  });
});
