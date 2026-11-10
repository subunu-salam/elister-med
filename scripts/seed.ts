import { config } from "dotenv";
config({ path: ".env.local" });

import { ensureIndexes, getDb, closeClient } from "../src/core/db";
import { seedOrg, DEMO_DOCTORS } from "../src/modules/org/seed";
import { seedExtras } from "../src/modules/org/seed-extras";
import { seedActivity } from "./seed-activity";
import { getAuth } from "../src/core/auth";
import { createPatient } from "../src/modules/patients/service";
import { permissionsFor, type RoleKey } from "../src/core/rbac/roles";

// Synthetic demo accounts. Password is demo-only; override with SEED_PASSWORD.
const PASSWORD = process.env.SEED_PASSWORD ?? "Demo-Only-Pass-2026!";
type U = { email: string; name: string; roles: RoleKey[]; userKey?: string; portal?: boolean };
const USERS: U[] = [
  { email: "admin@demo.local", name: "Demo Admin", roles: ["org_admin"] },
  { email: "manager@demo.local", name: "Demo Clinic Manager", roles: ["clinic_manager"] },
  { email: "director@demo.local", name: "Demo Medical Director", roles: ["medical_director"] },
  { email: "reception@demo.local", name: "Demo Receptionist", roles: ["receptionist"] },
  ...DEMO_DOCTORS.map((d) => ({ email: `${d.userKey}@demo.local`, name: d.name, roles: ["doctor"] as RoleKey[], userKey: d.userKey })),
  { email: "nurse@demo.local", name: "Demo Nurse", roles: ["nurse"] },
  { email: "insurance@demo.local", name: "Demo Insurance Coordinator", roles: ["insurance_coordinator"] },
  { email: "coder@demo.local", name: "Demo Medical Coder", roles: ["medical_coder"] },
  { email: "pharmacist@demo.local", name: "Demo Pharmacist", roles: ["pharmacist"] },
  { email: "lab1@demo.local", name: "Demo Lab Technician 1", roles: ["lab_technician"] },
  { email: "lab2@demo.local", name: "Demo Lab Technician 2", roles: ["lab_technician"] },
  { email: "radiologist@demo.local", name: "Demo Radiologist", roles: ["radiologist"] },
  { email: "accountant@demo.local", name: "Demo Accountant", roles: ["accountant"] },
  { email: "finance@demo.local", name: "Demo Finance Manager", roles: ["finance_manager"] },
  { email: "finance2@demo.local", name: "Demo Finance Manager 2", roles: ["finance_manager"] },
  { email: "hr@demo.local", name: "Demo HR Manager", roles: ["hr_manager"] },
  { email: "inventory@demo.local", name: "Demo Inventory Manager", roles: ["inventory_manager"] },
  { email: "auditor@demo.local", name: "Demo Auditor", roles: ["auditor"] },
  { email: "patient@demo.local", name: "Demo Patient (portal)", roles: ["patient_portal_user"], portal: true },
];

export async function seedAll(opts: { activity?: boolean } = {}) {
  await ensureIndexes();
  const { orgId, branchId } = await seedOrg();
  await seedExtras(orgId);
  const ctx = await getAuth().$context;
  const db = await getDb();

  // A synthetic patient linked to the portal account.
  const admin = { userId: "seed", orgId, branchId, roles: ["org_admin"] as RoleKey[], permissions: permissionsFor(["org_admin"]) };
  let portalPatient = (await db.collection("patients").findOne({ orgId, fullName: "Demo Patient Portal" }))?._id as unknown as string | undefined;
  if (!portalPatient) portalPatient = (await createPatient(admin, { fullName: "Demo Patient Portal", dob: "1990-06-15", sex: "female", phone: "+971500000099", email: "patient@demo.local", preferredLanguage: "en" }))._id;

  for (const u of USERS) {
    let user = await ctx.internalAdapter.findUserByEmail(u.email, { includeAccounts: false }).then((r) => r?.user);
    if (!user) {
      user = await ctx.internalAdapter.createUser({ email: u.email, name: u.name, emailVerified: true }, "seed" as never);
      await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash(PASSWORD) });
    }
    await db.collection("memberships").updateOne(
      { userId: user.id },
      { $set: { userId: user.id, orgId, branchId, roles: u.roles, active: true, ...(u.portal ? { patientId: portalPatient } : {}) } },
      { upsert: true },
    );
    if (u.userKey) await db.collection("staff").updateOne({ orgId, userKey: u.userKey }, { $set: { userId: user.id } });
  }
  if (opts.activity || process.env.SEED_DEMO_ACTIVITY === "1") await seedActivity(orgId, branchId);
  console.log(`Seeded org ${orgId} with ${USERS.length} synthetic users. Password: ${PASSWORD}`);
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedAll().then(async () => { await closeClient(); process.exit(0); }).catch(async (e) => { console.error(e); await closeClient(); process.exit(1); });
}
