import { ALL_PERMISSIONS, expand, type Permission } from "./permissions";

export const ROLE_KEYS = [
  "platform_super_admin", "org_admin", "clinic_manager", "medical_director", "doctor", "nurse",
  "receptionist", "insurance_coordinator", "medical_coder", "pharmacist", "lab_technician",
  "radiologist", "accountant", "finance_manager", "hr_manager", "inventory_manager", "auditor",
  "patient_portal_user",
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

const v = (...r: string[]) => r.map((x) => `${x}:view`);
// Ledger is immutable: nobody gets ledger:update. Corrections are reversing entries (ledger:create + approve).
const withoutLedgerUpdate = (ps: Permission[]) => ps.filter((p) => p !== "ledger:update");

const RAW: Record<RoleKey, string[]> = {
  platform_super_admin: ["*"],
  org_admin: ["*"],
  clinic_manager: [
    "patients:*", "appointments:*", "queue:*", "dashboard:view", "dashboard:export", "reports:view", "reports:export",
    "billing:view", "billing:approve", ...v("hr", "inventory", "compliance", "crm"), "crm:create", "crm:update",
    "communications:*", "org:view", "users:view", "audit:view", "ai:view",
  ],
  medical_director: [
    "patients:view", "appointments:view", "emr:view", "emr:approve", "emr:audit", "dashboard:view", "reports:view",
    "compliance:*", "audit:view", "audit:audit", ...v("radiology", "pharmacy", "queue"), "laboratory:view", "laboratory:approve",
  ],
  doctor: [
    "hospital:view", "hospital:create", "hospital:update", "hospital:approve", "ai:view", "ai:create",
    "patients:view", "patients:update", "appointments:view", "appointments:update", "queue:view", "queue:update",
    "emr:view", "emr:create", "emr:update", "emr:approve", "pharmacy:view", "pharmacy:create",
    "laboratory:view", "laboratory:create", "radiology:view", "radiology:create", "dashboard:view", "billing:view",
    "insurance:view",
  ],
  nurse: [
    "hospital:view", "hospital:create", "hospital:update",
    "patients:view", "appointments:view", "queue:view", "queue:update", "emr:view", "emr:create", "emr:update",
    "laboratory:view", "dashboard:view",
  ],
  receptionist: [
    "patients:view", "patients:create", "patients:update", "appointments:*", "queue:view", "queue:create",
    "queue:update", "billing:view", "billing:create", "billing:update", "dashboard:view", "insurance:view",
    "insurance:create", "crm:view", "crm:create", "crm:update", "communications:view", "communications:create", "ai:view",
  ],
  insurance_coordinator: [
    "patients:view", "insurance:view", "insurance:create", "insurance:update", "insurance:export", "billing:view", "billing:create",
    "dashboard:view", "reports:view", "integrations:view",
  ],
  medical_coder: ["patients:view", "emr:view", "insurance:view", "insurance:create", "insurance:update", "billing:view"],
  pharmacist: [
    "patients:view", "pharmacy:*", "inventory:view", "inventory:update", "emr:view", "dashboard:view", "billing:view",
  ],
  lab_technician: ["patients:view", "laboratory:view", "laboratory:create", "laboratory:update", "laboratory:approve", "dashboard:view", "inventory:view"],
  radiologist: ["patients:view", "radiology:*", "emr:view", "dashboard:view"],
  accountant: [
    "ledger:view", "ledger:create", "ledger:export", "billing:*", "reports:view", "reports:export", "dashboard:view",
    "patients:view", "insurance:view", "procurement:view", "procurement:create", "procurement:update", "inventory:view",
  ],
  finance_manager: [
    "ledger:view", "ledger:create", "ledger:approve", "ledger:export", "ledger:audit", "billing:*", "reports:*", "hr:view", "hr:approve", "ai:view",
    "dashboard:*", "patients:view", "insurance:view", "insurance:approve", "procurement:approve", "procurement:view",
    "audit:view", "hr:view", "hr:approve", "ai:view",
  ],
  hr_manager: ["hr:*", "users:view", "dashboard:view", "reports:view", "compliance:view"],
  inventory_manager: ["inventory:*", "procurement:*", "pharmacy:view", "dashboard:view", "reports:view"],
  auditor: [
    ...["org", "users", "audit", "patients", "appointments", "queue", "billing", "ledger", "reports", "dashboard",
      "insurance", "pharmacy", "laboratory", "inventory", "procurement", "hr", "compliance", "integrations"].map((r) => `${r}:view`),
    "audit:audit", "audit:export", "ledger:audit", "ledger:export", "reports:export", "emr:audit",
  ],
  patient_portal_user: [], // portal access is own-record-only, enforced by patient-scoped routes, not staff permissions
};

export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = Object.fromEntries(
  ROLE_KEYS.map((k) => [k, withoutLedgerUpdate(RAW[k][0] === "*" ? [...ALL_PERMISSIONS] : expand(RAW[k]))]),
) as Record<RoleKey, Permission[]>;

export function permissionsFor(roles: RoleKey[]): Permission[] {
  return [...new Set(roles.flatMap((r) => ROLE_PERMISSIONS[r] ?? []))];
}
