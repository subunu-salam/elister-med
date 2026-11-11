"use client";
import { usePathname } from "next/navigation";
import { Slide } from "@/ui/Slide";

/** Zoho Books-style section bar for /accounts. The highlight slides between sections; sub-sections use the page's own tabs. */
export const ACCOUNT_SECTIONS = [
  { key: "", label: "Overview" }, { key: "ai", label: "✦ AI CFO" }, { key: "sales", label: "Sales" }, { key: "purchases", label: "Purchases" },
  { key: "banking", label: "Banking" }, { key: "items", label: "Items" }, { key: "accountant", label: "Accountant" }, { key: "reports", label: "Reports" },
];

export function AccountsNav() {
  const path = usePathname();
  const seg = path.replace(/^\/accounts\/?/, "").split("/")[0] ?? "";
  return (
    <Slide label="Accounts sections" storeKey="accounts-nav" active={seg}
      items={ACCOUNT_SECTIONS.map((s) => ({ key: s.key, label: s.label, href: s.key ? `/accounts/${s.key}` : "/accounts" }))}
      track="glass-tabs flex max-w-full flex-wrap gap-1 rounded-xl p-1"
      itemClass="rounded-lg px-3.5 py-1.5 text-sm text-muted hover:text-fg" activeClass="!text-[var(--btn-fg)] font-medium hover:!text-[var(--btn-fg)]"
      thumbClass="rounded-lg bg-[var(--btn-bg)]" />
  );
}
