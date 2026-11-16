import { describe, expect, it } from "vitest";
import { modulesTouched, restrictToModules } from "./modules";
import { permissionsFor } from "./roles";

describe("module access", () => {
  const fm = permissionsFor(["finance_manager"]);
  it("changes nothing when no modules are chosen", () => {
    expect(restrictToModules(fm, undefined)).toEqual(fm);
    expect(restrictToModules(fm, null)).toEqual(fm);
  });
  it("closes every resource of a module that is switched off", () => {
    const p = restrictToModules(fm, ["finance", "assistant"]);
    expect(p).toContain("ledger:view");
    expect(p).toContain("ai:view");
    expect(p).not.toContain("billing:view");
    expect(p).not.toContain("hr:view");
  });
  it("keeps the dashboard and admin permissions, which belong to no module", () => {
    const p = restrictToModules(permissionsFor(["org_admin"]), []);
    expect(p).toContain("dashboard:view");
    expect(p).toContain("roles:update");
    expect(p).not.toContain("patients:view");
  });
  it("lists the modules a role touches", () => {
    expect(modulesTouched(permissionsFor(["receptionist"]))).toEqual(["clinical", "revenue", "crm", "assistant"]);
  });
});
