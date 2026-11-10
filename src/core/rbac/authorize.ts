import { AppError } from "../errors";
import type { Permission } from "./permissions";
import type { RoleKey } from "./roles";

export type Ctx = {
  userId: string;
  orgId: string;
  branchId: string;
  /** Set only for patient-portal users: the one patient record they may access. */
  patientId?: string;
  roles: RoleKey[];
  permissions: Permission[];
};

/** Pure check. Used by authorize() and directly in tests. */
export function assertPermission(ctx: Ctx, perm: Permission): Ctx {
  if (!ctx.permissions.includes(perm)) throw new AppError("FORBIDDEN", `Missing permission ${perm}`);
  return ctx;
}

type Resolver = () => Promise<Ctx | null>;
let resolver: Resolver | null = null;
/** Auth layer registers how to resolve the current request's context. */
export function setCtxResolver(r: Resolver) { resolver = r; }

/** Entry point for every server action / route handler. */
export async function authorize(perm: Permission): Promise<Ctx> {
  if (!resolver) throw new Error("No ctx resolver registered");
  const ctx = await resolver();
  if (!ctx) throw new AppError("UNAUTHENTICATED", "Not signed in");
  return assertPermission(ctx, perm);
}
