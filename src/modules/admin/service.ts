import "server-only";
import { ObjectId } from "mongodb";
import { getDb, tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { AppError } from "@/core/errors";
import { getAuth, loadCtx, type Membership } from "@/core/auth";
import { ROLE_KEYS, permissionsFor, type RoleKey } from "@/core/rbac/roles";
import { MODULE_KEYS, modulesTouched, restrictToModules, type ModuleKey } from "@/core/rbac/modules";
import type { Ctx } from "@/core/rbac/authorize";
import { adminSavePrefs, callNow, canBrief, getPrefs, type AssistantPrefs } from "@/modules/ai/brief";
import { deviceCount, ringDevices } from "@/modules/ai/push";

/**
 * Super admin control centre: people, roles, which business modules each person may use, and their personal assistant.
 * Only the highest authority (platform super admin or organisation admin) gets in. Guard rails: nobody can lock themselves out,
 * the organisation always keeps at least one active admin, and only a platform super admin can create another one.
 */
export const ADMIN_ROLES: RoleKey[] = ["platform_super_admin", "org_admin"];
export const isSuperAdmin = (ctx: Pick<Ctx, "roles">) => ctx.roles.some((r) => ADMIN_ROLES.includes(r));
export function assertSuperAdmin(ctx: Ctx) { if (!isSuperAdmin(ctx)) throw new AppError("FORBIDDEN", "Only the super admin can manage access"); }

export const ROLE_INFO: Record<RoleKey, { label: string; hint: string }> = {
  platform_super_admin: { label: "Platform super admin", hint: "Everything, including other admins" },
  org_admin: { label: "Organisation admin", hint: "Everything in this organisation" },
  clinic_manager: { label: "Clinic manager", hint: "Front office, scheduling, reports, CRM" },
  medical_director: { label: "Medical director", hint: "Clinical oversight and sign-off" },
  doctor: { label: "Doctor", hint: "Consultations, records, orders" },
  nurse: { label: "Nurse", hint: "Vitals, nursing notes, wards" },
  receptionist: { label: "Receptionist", hint: "Registration, booking, billing desk" },
  insurance_coordinator: { label: "Insurance coordinator", hint: "Approvals and claims" },
  medical_coder: { label: "Medical coder", hint: "Coding for claims" },
  pharmacist: { label: "Pharmacist", hint: "Dispensing and pharmacy stock" },
  lab_technician: { label: "Lab technician", hint: "Lab orders and results" },
  radiologist: { label: "Radiologist", hint: "Imaging and reports" },
  accountant: { label: "Accountant", hint: "Books, billing, purchasing" },
  finance_manager: { label: "Finance manager", hint: "Approvals, reports, payroll sign-off" },
  hr_manager: { label: "HR manager", hint: "Staff, leave, payroll" },
  inventory_manager: { label: "Inventory manager", hint: "Stock and purchasing" },
  auditor: { label: "Auditor", hint: "Read-only across the business" },
  patient_portal_user: { label: "Patient (portal)", hint: "Own record only" },
};
export const STAFF_ROLES = ROLE_KEYS.filter((r) => r !== "patient_portal_user");

const mems = async () => (await getDb()).collection<Membership & { title?: string; updatedAt?: Date }>("memberships");
const users = async () => (await getDb()).collection<{ _id: ObjectId; name: string; email: string; createdAt?: Date }>("user");
const logAdmin = (ctx: Ctx, action: string, userId: string, after: unknown) =>
  withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: `admin.${action}`, resource: "user", resourceId: userId, after }));

export type AdminUser = {
  userId: string; name: string; email: string; title?: string; roles: RoleKey[]; active: boolean; modules: ModuleKey[] | null;
  /** modules the person's role touches; effective = what they can actually use after the super admin's choice */
  available: ModuleKey[]; effective: ModuleKey[]; lastActive: Date | null; actions30d: number;
  assistant: { eligible: boolean; enabled: boolean; callTime: string; locked: boolean; devices: number };
};

export async function listUsers(ctx: Ctx): Promise<AdminUser[]> {
  assertSuperAdmin(ctx);
  const ms = await (await mems()).find({ orgId: ctx.orgId }).toArray();
  const ids = ms.map((m) => m.userId).filter((i) => ObjectId.isValid(i)).map((i) => new ObjectId(i));
  const us = new Map((await (await users()).find({ _id: { $in: ids } }).toArray()).map((u) => [String(u._id), u]));
  const since = new Date(Date.now() - 30 * 86400000);
  const act = new Map((await tenantCol(ctx.orgId, "audit_log").aggregate<{ _id: string; n: number; last: Date }>([
    { $match: { at: { $gte: since } } }, { $group: { _id: "$actorId", n: { $sum: 1 }, last: { $max: "$at" } } },
  ])).map((r) => [r._id, r]));
  return Promise.all(ms.filter((m) => !m.roles.includes("patient_portal_user")).map(async (m) => {
    const rolePerms = permissionsFor(m.roles);
    const eff = restrictToModules(rolePerms, m.modules);
    const prefs = await getPrefs(ctx.orgId, m.userId);
    const u = us.get(m.userId);
    return {
      userId: m.userId, name: u?.name ?? "(unknown)", email: u?.email ?? "", title: m.title, roles: m.roles, active: m.active,
      modules: (m.modules as ModuleKey[] | null | undefined) ?? null, available: modulesTouched(rolePerms), effective: modulesTouched(eff),
      lastActive: act.get(m.userId)?.last ?? null, actions30d: act.get(m.userId)?.n ?? 0,
      assistant: { eligible: canBrief({ ...ctx, roles: m.roles, permissions: eff }), enabled: prefs.enabled, callTime: prefs.callTime, locked: !!prefs.lockedBy, devices: await deviceCount(ctx.orgId, m.userId) },
    } satisfies AdminUser;
  })).then((r) => r.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)));
}

export async function getUser(ctx: Ctx, userId: string) {
  const u = (await listUsers(ctx)).find((x) => x.userId === userId);
  if (!u) throw new AppError("NOT_FOUND", "User not found in this organisation");
  return { ...u, prefs: await getPrefs(ctx.orgId, userId) };
}

function cleanRoles(ctx: Ctx, roles: string[]): RoleKey[] {
  const r = [...new Set(roles)].filter((x): x is RoleKey => (STAFF_ROLES as string[]).includes(x));
  if (!r.length) throw new AppError("VALIDATION", "Give the person at least one role");
  if (r.includes("platform_super_admin") && !ctx.roles.includes("platform_super_admin")) throw new AppError("FORBIDDEN", "Only a platform super admin can grant platform super admin");
  return r;
}
const cleanModules = (mods: string[] | null): ModuleKey[] | null => (mods === null ? null : MODULE_KEYS.filter((k) => mods.includes(k)));

async function activeAdmins(orgId: string, except?: string) {
  return (await mems()).countDocuments({ orgId, active: true, roles: { $in: ADMIN_ROLES }, ...(except ? { userId: { $ne: except } } : {}) });
}

/** Roles, module access, job title and active flag for one person. modules = null means "everything the role allows". */
export async function updateAccess(ctx: Ctx, userId: string, input: { roles: string[]; modules: string[] | null; active: boolean; title?: string }) {
  assertSuperAdmin(ctx);
  const col = await mems();
  const m = await col.findOne({ orgId: ctx.orgId, userId });
  if (!m) throw new AppError("NOT_FOUND", "User not found in this organisation");
  const roles = cleanRoles(ctx, input.roles);
  const modules = cleanModules(input.modules);
  const stillAdmin = input.active && roles.some((r) => ADMIN_ROLES.includes(r));
  if (userId === ctx.userId && !stillAdmin) throw new AppError("CONFLICT", "You can't remove your own admin access or deactivate yourself");
  if (!stillAdmin && m.roles.some((r) => ADMIN_ROLES.includes(r)) && (await activeAdmins(ctx.orgId, userId)) === 0) throw new AppError("CONFLICT", "The organisation must keep at least one active admin");
  if (m.roles.includes("platform_super_admin") && !ctx.roles.includes("platform_super_admin")) throw new AppError("FORBIDDEN", "Only a platform super admin can change another platform super admin");
  const set = { roles, modules, active: input.active, title: input.title?.trim().slice(0, 80) || undefined, updatedAt: new Date() };
  await col.updateOne({ orgId: ctx.orgId, userId }, { $set: set });
  await logAdmin(ctx, "access", userId, { before: { roles: m.roles, modules: m.modules ?? null, active: m.active }, after: set });
}

/** Creates a login and gives it access. The person signs in with the temporary password and should change it (and set up MFA). */
export async function createUser(ctx: Ctx, input: { name: string; email: string; password: string; roles: string[]; modules: string[] | null; title?: string }) {
  assertSuperAdmin(ctx);
  const name = input.name.trim(), email = input.email.trim().toLowerCase();
  if (name.length < 2) throw new AppError("VALIDATION", "Enter the person's name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError("VALIDATION", "Enter a valid email address");
  if (input.password.length < 12) throw new AppError("VALIDATION", "The temporary password must be at least 12 characters");
  const roles = cleanRoles(ctx, input.roles);
  const auth = await getAuth().$context;
  const existing = await auth.internalAdapter.findUserByEmail(email, { includeAccounts: false }).then((r) => r?.user);
  if (existing) {
    const other = await (await mems()).findOne({ userId: existing.id });
    if (other) throw new AppError("CONFLICT", other.orgId === ctx.orgId ? "This person already has access; edit them instead" : "This email already belongs to another organisation");
  }
  const user = existing ?? await auth.internalAdapter.createUser({ email, name, emailVerified: true }, "admin" as never);
  if (!existing) await auth.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await auth.password.hash(input.password) });
  const doc = { userId: user.id, orgId: ctx.orgId, branchId: ctx.branchId, roles, modules: cleanModules(input.modules), active: true, title: input.title?.trim() || undefined, updatedAt: new Date() };
  await (await mems()).insertOne(doc as never);
  await logAdmin(ctx, "create_user", user.id, { email, roles, modules: doc.modules });
  return user.id;
}

/** Sets someone's personal assistant (call time, days, language, report sections) and optionally locks it so they can't change it. */
export async function setAssistant(ctx: Ctx, userId: string, input: Partial<AssistantPrefs> & { lock?: boolean }) {
  assertSuperAdmin(ctx);
  await getUser(ctx, userId);
  const p = await adminSavePrefs(ctx, userId, input);
  await logAdmin(ctx, "assistant", userId, p);
}

/** Rings this person's devices now (for checking their setup or showing the client). */
export async function ringUser(ctx: Ctx, userId: string) {
  assertSuperAdmin(ctx);
  const u = await getUser(ctx, userId);
  const target = await loadCtx(userId);
  if (!target || !u.assistant.eligible) throw new AppError("CONFLICT", "This person's access does not include the personal assistant");
  const r = await callNow({ ...target, name: u.name }, ringDevices);
  await logAdmin(ctx, "ring", userId, { devices: r.devices });
  return r.devices;
}

export async function adminActivity(ctx: Ctx, limit = 15) {
  assertSuperAdmin(ctx);
  const rows = await tenantCol<{ action: string; actorId: string; resourceId: string; at: Date }>(ctx.orgId, "audit_log").find({ action: { $regex: "^admin\\." } } as never, { sort: { at: -1 }, limit });
  return rows;
}
