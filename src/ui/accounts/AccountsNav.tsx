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
      track="glass-tabs flex max-w-full flex-wrap gap-1 rounded-full p-1.5"
      itemClass="rounded-full px-4 py-1.5 text-sm text-muted hover:text-fg" activeClass="!text-[var(--btn-fg)] font-medium hover:!text-[var(--btn-fg)]"
      thumbClass="rounded-full bg-[var(--btn-bg)] shadow-[inset_0_1px_0_rgba(255,255,255,.18),0_6px_14px_-8px_rgba(11,53,88,.7)]" />
  );
}
