import Link from "next/link";
import { requireCtx } from "@/lib/session";
import { todayYmd } from "@/lib/range";
import { tenantCol } from "@/core/db";
import { Alert, Card, Stat, Table, cn } from "@/ui/kit";
import { ActionForm, fmtDate } from "@/ui/forms";
import * as coa from "@/modules/ledger/coa";
import { m } from "../_shared";

const HOLDERS = [{ code: "1010", sys: "bank", label: "Bank - Current" }, { code: "1016", sys: "bank_savings", label: "Bank - Savings" }, { code: "1000", sys: "cash", label: "Cash on hand" }, { code: "1015", sys: "petty_cash", label: "Petty cash" }];

export default async function BankingPage({ searchParams }: { searchParams: Promise<{ error?: string; account?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const can = ctx.permissions.includes("ledger:create" as never);
  const sel = HOLDERS.find((h) => h.code === sp.account) ?? HOLDERS[0];
  const all = await coa.listAccounts(ctx);
  const to = new Date(Date.now() + 86400000), from = new Date(Date.now() - 60 * 86400000);
  const [gl, unmatched] = await Promise.all([
    coa.generalLedger(ctx, { code: sel.code, from, to }).catch(() => null),
    tenantCol(ctx.orgId, "bank_transactions").count({ status: "unmatched" } as never),
  ]);
  const opts = (types: string[]) => all.filter((a) => a.active && types.includes(a.type) && !HOLDERS.some((h) => h.code === a.code)).map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }));
  const holders = HOLDERS.map((h) => ({ value: h.sys, label: h.label }));
  return (
    <div className="space-y-4">
      {sp.error && <Alert>{sp.error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {HOLDERS.map((h) => { const a = all.find((x) => x.code === h.code); return (
          <Link key={h.code} href={`/accounts/banking?account=${h.code}`} className={cn("rounded-ui transition", sel.code === h.code && "ring-2 ring-primary")}><Stat label={`${h.code} ${a?.name ?? h.label}`} value={m(a?.balance ?? { toFixed: () => "0" })} /></Link>
        ); })}
      </div>
      {unmatched > 0 && <Alert tone="warn">{unmatched} imported bank statement line(s) are not matched to the ledger yet. <Link className="underline" href="/finance?tab=bank">Reconcile now →</Link></Alert>}
      <Card title={`${sel.label}: last 60 days`} action={<span className="space-x-3 text-xs"><Link className="text-primary hover:underline" href="/finance?tab=bank">Import statement & reconcile</Link><Link className="text-primary hover:underline" href={`/accounts/reports?r=general-ledger&code=${sel.code}`}>Full ledger</Link></span>}>
        {gl ? <Table head={["Date", "Entry", "Description", "Money in", "Money out", "Balance"]} empty="No movement in the last 60 days.">
          {[...gl.rows].reverse().slice(0, 40).map((r, i) => <tr key={i}><td>{fmtDate(r.date)}</td><td className="font-mono text-xs">#{r.entryNo}</td><td>{r.memo}</td><td className="tabular-nums text-ok">{r.debit.isZero() ? "" : m(r.debit)}</td><td className="tabular-nums">{r.credit.isZero() ? "" : m(r.credit)}</td><td className="tabular-nums">{m(r.balance)}</td></tr>)}
        </Table> : <p className="text-sm text-muted">This account is not set up.</p>}
      </Card>
      {can && (
        <div id="new" className="grid gap-4 lg:grid-cols-3">
          <Card title="Money in"><ActionForm action="bk.bank" back="/accounts/banking" hidden={{ type: "deposit" }} submit="Record deposit" fields={[
            { name: "account", label: "Into", type: "select", options: holders }, { name: "other", label: "From account (credit)", type: "select", options: opts(["income", "liability", "equity"]) }, { name: "amount", label: "Amount", required: true }, { name: "date", label: "Date", type: "date", defaultValue: todayYmd() }, { name: "description", label: "Description", required: true }]} /></Card>
          <Card title="Money out"><ActionForm action="bk.bank" back="/accounts/banking" hidden={{ type: "withdrawal" }} submit="Record withdrawal" fields={[
            { name: "account", label: "From", type: "select", options: holders }, { name: "other", label: "To account (debit)", type: "select", options: opts(["expense", "asset", "liability", "equity"]) }, { name: "amount", label: "Amount", required: true }, { name: "date", label: "Date", type: "date", defaultValue: todayYmd() }, { name: "description", label: "Description", required: true }]} /></Card>
          <Card title="Transfer between accounts"><ActionForm action="bk.bank" back="/accounts/banking" hidden={{ type: "transfer" }} submit="Transfer" fields={[
            { name: "other", label: "From", type: "select", options: holders }, { name: "account", label: "To", type: "select", options: holders, defaultValue: "cash" }, { name: "amount", label: "Amount", required: true }, { name: "date", label: "Date", type: "date", defaultValue: todayYmd() }, { name: "description", label: "Description", required: true }]} /></Card>
        </div>
      )}
    </div>
  );
}
