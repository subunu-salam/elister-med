import type { Permission, Resource } from "./permissions";

/**
 * Business modules the super admin switches on or off per person, on top of their role. A role says what someone may DO
 * (view, create, approve…); module access says which PARTS of the business they may touch at all. Both apply: a person's permissions are
 * their role's permissions minus every resource in a module they have not been given. Because every service checks permissions
 * server-side, a switched-off module is really closed, not just hidden from the menu.
 */
export const MODULES = [
  { key: "clinical", label: "Clinical", hint: "Patients, appointments, queue, medical records, wards", resources: ["patients", "appointments", "queue", "emr", "hospital"] },
  { key: "diagnostics", label: "Lab & radiology", hint: "Lab orders and results, imaging", resources: ["laboratory", "radiology"] },
  { key: "pharmacy", label: "Pharmacy", hint: "Prescriptions and dispensing", resources: ["pharmacy"] },
  { key: "revenue", label: "Billing & insurance", hint: "Invoices, payments, claims", resources: ["billing", "insurance"] },
  { key: "finance", label: "Finance & reports", hint: "Accounts, ledger, revenue reports, AI CFO", resources: ["ledger", "reports"] },
  { key: "operations", label: "Inventory & purchasing", hint: "Stock, suppliers, purchase orders", resources: ["inventory", "procurement"] },
  { key: "people", label: "HR & payroll", hint: "Staff, leave, payroll, WPS", resources: ["hr"] },
  { key: "crm", label: "CRM & messaging", hint: "Leads, campaigns, patient messages", resources: ["crm", "communications"] },
  { key: "compliance", label: "Compliance & audit", hint: "Policies, incidents, audit trail, integrations", resources: ["compliance", "audit", "integrations"] },
  { key: "assistant", label: "AI assistant", hint: "Personal AI assistant, daily call, assistants", resources: ["ai"] },
] as const satisfies readonly { key: string; label: string; hint: string; resources: readonly Resource[] }[];

export type ModuleKey = (typeof MODULES)[number]["key"];
export const MODULE_KEYS = MODULES.map((m) => m.key) as ModuleKey[];

const RES_TO_MODULE = new Map<string, ModuleKey>(MODULES.flatMap((m) => m.resources.map((r) => [r, m.key] as [string, ModuleKey])));

/** Removes permissions for modules the person has not been given. undefined = no restriction (role decides everything). */
export function restrictToModules(perms: Permission[], modules: readonly string[] | undefined | null): Permission[] {
  if (!modules) return perms;
  const allowed = new Set(modules);
  return perms.filter((p) => { const m = RES_TO_MODULE.get(p.split(":")[0]); return !m || allowed.has(m); });
}

/** Modules that a set of role permissions touches at all (what there is to switch on/off for this person). */
export function modulesTouched(perms: Permission[]): ModuleKey[] {
  const out = new Set<ModuleKey>();
  for (const p of perms) { const m = RES_TO_MODULE.get(p.split(":")[0]); if (m) out.add(m); }
  return MODULE_KEYS.filter((k) => out.has(k));
}
