export const RESOURCES = [
  "org", "users", "roles", "audit", "patients", "appointments", "queue", "emr", "billing", "ledger",
  "reports", "dashboard", "insurance", "pharmacy", "laboratory", "radiology", "inventory",
  "procurement", "hr", "crm", "communications", "compliance", "integrations", "ai", "hospital",
] as const;
export const ACTIONS = ["view", "create", "update", "approve", "export", "audit"] as const;

export type Resource = (typeof RESOURCES)[number];
export type Action = (typeof ACTIONS)[number];
export type Permission = `${Resource}:${Action}`;

export const ALL_PERMISSIONS: Permission[] = RESOURCES.flatMap((r) => ACTIONS.map((a) => `${r}:${a}` as Permission));

/** Expand "res:*" shorthand and plain permissions. */
export function expand(specs: string[]): Permission[] {
  const out = new Set<Permission>();
  for (const s of specs) {
    const [r, a] = s.split(":");
    if (a === "*") ACTIONS.forEach((x) => out.add(`${r}:${x}` as Permission));
    else out.add(s as Permission);
  }
  return [...out];
}
