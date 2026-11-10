import { permissionsFor, type RoleKey } from "@/core/rbac/roles";
import type { Ctx } from "@/core/rbac/authorize";

export const ctxFor = (roles: RoleKey[], orgId = "test-org", userId = "u-test", branchId = "b-test"): Ctx =>
  ({ userId, orgId, branchId, roles, permissions: permissionsFor(roles) });
