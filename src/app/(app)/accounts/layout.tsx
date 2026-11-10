import Link from "next/link";
import { requireCtx } from "@/lib/session";
import { NoAccess } from "@/ui/kit";
import { AccountsNav } from "@/ui/accounts/AccountsNav";

/** Accounts: one Zoho Books-style home for everything financial. Every page reads and posts to the same Elister general ledger. */
export default async function AccountsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireCtx();
  if (!ctx.permissions.includes("ledger:view")) return <NoAccess what="Accounts" />;
  const can = ctx.permissions.includes("ledger:create" as never);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted">Business OS · Accounts</p>
          <h1 className="text-2xl font-semibold">Accounts</h1>
        </div>
        {can && (
          <details className="relative">
            <summary className="cursor-pointer list-none rounded-full bg-[var(--btn-bg)] px-4 py-2 text-sm font-medium text-[var(--btn-fg)]">+ New</summary>
            <div className="absolute end-0 z-20 mt-2 grid w-56 gap-1 rounded-ui border border-border bg-surface p-2 text-sm shadow-card">
              {[["Invoice", "/accounts/sales?tab=invoices#new"], ["Quote", "/accounts/sales?tab=quotes#new"], ["Customer payment", "/accounts/sales?tab=payments#new"], ["Expense", "/accounts/purchases?tab=expenses#new"], ["Bill", "/accounts/purchases?tab=bills#new"], ["Manual journal", "/accounts/accountant?tab=journals#new"], ["Item", "/accounts/items#new"], ["Bank transaction", "/accounts/banking#new"]].map(([l, h]) => (
                <Link key={h} href={h} className="rounded px-2 py-1.5 hover:bg-surface-2">{l}</Link>
              ))}
            </div>
          </details>
        )}
      </div>
      <AccountsNav />
      {children}
    </div>
  );
}
