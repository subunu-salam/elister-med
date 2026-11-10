import Link from "next/link";
import { requireCtx } from "@/lib/session";
import { parseRange } from "@/lib/range";
import { trialBalance } from "@/modules/reports/trialBalance";
import { pnl } from "@/modules/reports/pnl";
import { arAging } from "@/modules/reports/arAging";
import { listJournals } from "@/modules/ledger/journal";
import { listPeriods } from "@/modules/ledger/periods";
import { Alert, Badge, Button, Card, Input, NoAccess, PageHeader, Table, aed, cn } from "@/ui/kit";
import { lockAction, reverseAction } from "./actions";

const TABS = ["trial-balance", "pnl", "aging", "journal", "periods"] as const;
const LABEL: Record<(typeof TABS)[number], string> = { "trial-balance": "Trial balance", pnl: "Profit & loss", aging: "AR aging", journal: "Journal", periods: "Periods" };
const f2 = (d: { toFixed: (n: number) => string }) => d.toFixed(2);

export default async function AccountingPage({ searchParams }: { searchParams: Promise<{ tab?: string; from?: string; to?: string; error?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const tab = (TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as (typeof TABS)[number]) : "trial-balance";
  const { from, to, fromStr, toStr } = parseRange(sp);
  const can = (p: string) => ctx.permissions.includes(p as never);
  if (!can("ledger:view")) return <NoAccess what="accounting" />;

  return (
    <div className="space-y-4">
      <PageHeader title="Accounting" sub="Every figure is computed from the posted general ledger"
        actions={(tab === "pnl" || tab === "trial-balance") && (
          <form className="flex items-end gap-2"><input type="hidden" name="tab" value={tab} /><Input name="from" type="date" defaultValue={fromStr} aria-label="From" /><Input name="to" type="date" defaultValue={toStr} aria-label="To" /><Button variant="outline">Apply</Button></form>
        )} />
      {sp.error && <Alert>{sp.error}</Alert>}
      <nav className="flex gap-1 border-b border-border" aria-label="Accounting sections">
        {TABS.map((t) => <Link key={t} href={`?tab=${t}`} aria-current={t === tab ? "page" : undefined} className={cn("-mb-px border-b-2 px-3 py-2 text-sm", t === tab ? "border-primary font-medium text-primary" : "border-transparent text-muted hover:text-fg")}>{LABEL[t]}</Link>)}
      </nav>

      {tab === "trial-balance" && <TrialBalance ctx={ctx} from={from} to={to} />}
      {tab === "pnl" && <Pnl ctx={ctx} from={from} to={to} />}
      {tab === "aging" && <Aging ctx={ctx} />}
      {tab === "journal" && <Journal ctx={ctx} canReverse={can("ledger:approve")} />}
      {tab === "periods" && <Periods ctx={ctx} canLock={can("ledger:approve")} />}
    </div>
  );
}

type C = Awaited<ReturnType<typeof requireCtx>>;

async function TrialBalance({ ctx, from, to }: { ctx: C; from: Date; to: Date }) {
  const tb = await trialBalance(ctx, { from, to });
  const ok = tb.totalDebit.equals(tb.totalCredit);
  return (
    <Card title="Trial balance" action={<Badge tone={ok ? "ok" : "danger"}>{ok ? "Balanced" : "OUT OF BALANCE"}</Badge>}>
      <Table head={["Code", "Account", "Debit", "Credit", "Balance"]} empty={tb.rows.length ? undefined : "No postings in this period."}>
        {tb.rows.map((r) => <tr key={r.accountId}><td className="font-mono text-xs">{r.code}</td><td>{r.name}</td><td className="tabular-nums">{f2(r.debit)}</td><td className="tabular-nums">{f2(r.credit)}</td><td className="tabular-nums">{f2(r.balance)}</td></tr>)}
        <tr className="font-semibold"><td /><td>Total</td><td className="tabular-nums">{f2(tb.totalDebit)}</td><td className="tabular-nums">{f2(tb.totalCredit)}</td><td /></tr>
      </Table>
    </Card>
  );
}

async function Pnl({ ctx, from, to }: { ctx: C; from: Date; to: Date }) {
  const p = await pnl(ctx, { from, to });
  return (
    <Card title="Profit & loss">
      <Table head={["Code", "Type", "Amount"]} empty={p.byAccount.length ? undefined : "No income or expense in this period."}>
        {p.byAccount.map((a) => <tr key={a.code}><td className="font-mono text-xs">{a.code}</td><td className="capitalize">{a.type}</td><td className="tabular-nums">{aed(f2(a.amount))}</td></tr>)}
      </Table>
      <dl className="ms-auto mt-3 grid max-w-xs grid-cols-2 gap-y-1 text-sm">
        <dt className="text-muted">Income</dt><dd className="text-end tabular-nums">{aed(f2(p.income))}</dd>
        <dt className="text-muted">Expenses</dt><dd className="text-end tabular-nums">{aed(f2(p.expense))}</dd>
        <dt className="font-medium">Net profit</dt><dd className="text-end font-semibold tabular-nums">{aed(f2(p.net))}</dd>
      </dl>
    </Card>
  );
}

async function Aging({ ctx }: { ctx: C }) {
  const a = await arAging(ctx, {});
  return (
    <Card title="Patient receivables aging">
      <Table head={["Age (days)", "Invoices", "Outstanding"]}>
        {a.buckets.map((b) => <tr key={b.label}><td>{b.label}</td><td>{b.count}</td><td className="tabular-nums">{aed(f2(b.amount))}</td></tr>)}
        <tr className="font-semibold"><td>Total</td><td /><td className="tabular-nums">{aed(f2(a.total))}</td></tr>
      </Table>
    </Card>
  );
}

async function Journal({ ctx, canReverse }: { ctx: C; canReverse: boolean }) {
  const rows = await listJournals(ctx, 50);
  return (
    <Card title="Recent journal entries (append-only)">
      <Table head={["#", "Date", "Memo", "Source", ""]} empty={rows.length ? undefined : "No entries yet."}>
        {rows.map((r) => (
          <tr key={r._id}>
            <td className="font-mono text-xs">{r.entryNo}</td>
            <td>{new Date(r.date).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai" })}</td>
            <td>{r.memo}{r.reversalOf && <Badge tone="warn">reversal</Badge>}{r.reversed && <Badge tone="neutral">reversed</Badge>}</td>
            <td className="text-xs text-muted">{r.sourceRef.type}</td>
            <td>{canReverse && !r.reversed && !r.reversalOf && (
              <form action={reverseAction} className="flex gap-1"><input type="hidden" name="entryId" value={r._id} /><Input name="reason" required placeholder="Reason" className="h-7 w-32 py-1 text-xs" aria-label="Reversal reason" /><Button variant="ghost" className="px-2 py-1 text-xs">Reverse</Button></form>
            )}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

async function Periods({ ctx, canLock }: { ctx: C; canLock: boolean }) {
  const ps = await listPeriods(ctx);
  return (
    <Card title="Fiscal periods">
      <Table head={["Period", "Status", ""]}>
        {ps.map((p) => (
          <tr key={p._id}>
            <td>{p.year}-{String(p.month).padStart(2, "0")}</td>
            <td><Badge tone={p.status === "open" ? "ok" : "neutral"}>{p.status}</Badge></td>
            <td>{canLock && p.status === "open" && <form action={lockAction}><input type="hidden" name="year" value={p.year} /><input type="hidden" name="month" value={p.month} /><Button variant="ghost" className="px-2 py-1 text-xs">Lock</Button></form>}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
