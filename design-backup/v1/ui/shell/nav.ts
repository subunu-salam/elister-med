import type { Permission } from "@/core/rbac/permissions";

export type NavItem = { href: string; labelKey: string; perm: Permission; portal?: boolean; icon: "dash" | "users" | "cal" | "queue" | "bill" | "book" | "shield" | "med" | "flask" | "box" | "people" | "heart" | "chat" | "check" | "bank" | "bed" | "bot" };

/** Hiding items is cosmetic. Every page and action still authorizes server-side. */
export const NAV: NavItem[] = [
  { href: "/dashboard", labelKey: "nav.dashboard", perm: "dashboard:view", icon: "dash" },
  { href: "/patients", labelKey: "nav.patients", perm: "patients:view", icon: "users" },
  { href: "/appointments", labelKey: "nav.appointments", perm: "appointments:view", icon: "cal" },
  { href: "/queue", labelKey: "nav.queue", perm: "queue:view", icon: "queue" },
  { href: "/billing", labelKey: "nav.billing", perm: "billing:view", icon: "bill" },
  { href: "/accounting", labelKey: "nav.accounting", perm: "ledger:view", icon: "book" },
  { href: "/insurance", labelKey: "nav.insurance", perm: "insurance:view", icon: "heart" },
  { href: "/pharmacy", labelKey: "nav.pharmacy", perm: "pharmacy:view", icon: "med" },
  { href: "/inventory", labelKey: "nav.inventory", perm: "inventory:view", icon: "box" },
  { href: "/procurement", labelKey: "nav.procurement", perm: "procurement:view", icon: "box" },
  { href: "/laboratory", labelKey: "nav.laboratory", perm: "laboratory:view", icon: "flask" },
  { href: "/radiology", labelKey: "nav.radiology", perm: "radiology:view", icon: "flask" },
  { href: "/finance", labelKey: "nav.finance", perm: "reports:view", icon: "bank" },
  { href: "/books", labelKey: "nav.books", perm: "ledger:view", icon: "book" },
  { href: "/tax", labelKey: "nav.tax", perm: "ledger:view", icon: "bank" },
  { href: "/hr", labelKey: "nav.hr", perm: "hr:view", icon: "people" },
  { href: "/crm", labelKey: "nav.crm", perm: "crm:view", icon: "chat" },
  { href: "/communications", labelKey: "nav.communications", perm: "communications:view", icon: "chat" },
  { href: "/hospital", labelKey: "nav.hospital", perm: "hospital:view", icon: "bed" },
  { href: "/compliance", labelKey: "nav.compliance", perm: "compliance:view", icon: "check" },
  { href: "/ai", labelKey: "nav.ai", perm: "ai:view", icon: "bot" },
  { href: "/portal", labelKey: "nav.portal", perm: "dashboard:view", icon: "heart", portal: true },
  { href: "/settings/security", labelKey: "nav.settings", perm: "dashboard:view", icon: "shield" },
];
