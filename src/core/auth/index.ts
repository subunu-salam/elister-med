import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { twoFactor } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { headers } from "next/headers";
import { getDbLazy } from "../db/client";
import { getDb } from "../db/client";
import { permissionsFor, type RoleKey } from "../rbac/roles";
import { setCtxResolver, type Ctx } from "../rbac/authorize";

function build() {
  return betterAuth({
    database: mongodbAdapter(getDbLazy()),
    secret: process.env.AUTH_SECRET,
    trustedOrigins: (process.env.TRUSTED_ORIGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    emailAndPassword: { enabled: true, minPasswordLength: 12, autoSignIn: true },
    session: { expiresIn: 60 * 60 * 8, updateAge: 60 * 15, cookieCache: { enabled: false } },
    plugins: [twoFactor({ issuer: "Elister Med" }), nextCookies()],
  });
}

type Auth = ReturnType<typeof build>;
let instance: Auth | undefined;
export function getAuth(): Auth {
  return (instance ??= build());
}

export type Membership = { userId: string; orgId: string; branchId: string; roles: RoleKey[]; active: boolean; patientId?: string };

/** Display names for user ids (user records are global, not per organisation). Unknown or malformed ids are simply absent. */
export async function userNames(ids: string[]): Promise<Map<string, string>> {
  const { ObjectId } = await import("mongodb");
  const oids = ids.filter((i) => ObjectId.isValid(i)).map((i) => new ObjectId(i));
  if (!oids.length) return new Map();
  const rows = await (await getDb()).collection("user").find({ _id: { $in: oids } } as never, { projection: { name: 1 } }).toArray();
  return new Map(rows.map((u) => [String(u._id), String((u as { name?: string }).name ?? "")]));
}

export async function loadCtx(userId: string): Promise<Ctx | null> {
  const db = await getDb();
  const m = await db.collection<Membership>("memberships").findOne({ userId, active: true });
  if (!m) return null;
  return { userId, orgId: m.orgId, branchId: m.branchId, roles: m.roles, permissions: permissionsFor(m.roles), ...(m.patientId ? { patientId: m.patientId } : {}) };
}

setCtxResolver(async () => {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session?.user) return null;
  return loadCtx(session.user.id);
});
