import Link from "next/link";
import { requireCtx } from "@/lib/session";
import { Badge, Card, NoAccess, Stat, Table } from "@/ui/kit";
import { fmtDate } from "@/ui/forms";
import { cfoInsights } from "@/modules/accounts/insights";
import { tradeAging } from "@/modules/books/service";
import { apAging } from "@/modules/procurement/service";
import { listJournals } from "@/modules/ledger/journal";
import { AiTag, ForecastChart, Quick, ScoreRing, m, num } from "./_shared";

export default async function AccountsOverview() {
  const ctx = await requireCtx();
  if (!ctx.permissions.includes("reports:view")) return <NoAccess what="the accounts dashboard" />;
  const [ai, ar, ap, journals] = await Promise.all([cfoInsights(ctx), tradeAging(ctx), apAging(ctx).catch(() => null), listJournals(ctx, 8)]);
  const s = ai.summary;
  const top = [
    ...ai.anomalies.slice(0, 2).map((a) => ({ tone: a.severity === "high" ? "danger" : "warn", title: a.title, detail: a.detail, href: "/accounts/ai#anomalies" })),
    ...ai.duplicates.slice(0, 1).map((d) => ({ tone: "warn", title: `Possible duplicate: ${d.a.vendor}`, detail: d.reason, href: "/accounts/ai#duplicates" })),
    ...ai.collections.filter((c) => c.stage !== "Not due").slice(0, 1).map((c) => ({ tone: "info", title: `Chase ${c.customer}`, detail: `${c.number}: ${num(c.balance)}, ${c.daysOverdue} days overdue`, href: "/accounts/ai#collections" })),
  ].slice(0, 3) as { tone: "danger" | "warn" | "info"; title: string; detail: string; href: string }[];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Cash and bank" value={m(s.cash)} hint="Cash, current, savings, petty cash" />
        <Stat label="Total receivables" value={m(s.receivables)} hint="Patients, insurers and corporate clients" />
        <Stat label="Total payables" value={m(s.payables)} />
        <Stat label="VAT payable" value={m(s.vatPayable)} hint="Output less recoverable input" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={<span className="flex items-center gap-2">Financial health <AiTag /></span>} action={<Link href="/accounts/ai" className="text-xs text-primary hover:underline">Open AI CFO →</Link>}>
          <div className="flex items-center gap-5">
            <ScoreRing score={ai.health.score} label={ai.health.grade} />
            <ul className="space-y-1.5 text-sm">{ai.health.factors.map((f) => <li key={f.key} className="flex justify-between gap-3"><span className="text-muted">{f.label}</span><span className="font-medium tabular-nums">{f.display}</span></li>)}</ul>
          </div>
        </Card>
        <Card className="lg:col-span-2" title={<span className="flex items-center gap-2">Cash forecast, next 13 weeks <AiTag>Forecast</AiTag></span>}
          action={ai.forecast.breachWeek ? <Badge tone="danger">Cash below zero in week {ai.forecast.breachWeek}</Badge> : <Badge tone="ok">Stays positive</Badge>}>
          <ForecastChart points={ai.forecast.points} opening={s.cash.toNumber()} compact />
          <p className="mt-1 text-xs text-muted">Lowest point {num(ai.forecast.lowest.amount)} in week {ai.forecast.lowest.week}. Hover a point for inflows and outflows.</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={<span className="flex items-center gap-2">Needs your attention <AiTag /></span>}>
          {top.length ? <ul className="space-y-3">{top.map((t) => (
            <li key={t.title}><Link href={t.href} className="block rounded-ui border border-border p-3 hover:bg-surface-2"><div className="flex items-center gap-2"><Badge tone={t.tone}>{t.tone === "danger" ? "High" : t.tone === "warn" ? "Check" : "Action"}</Badge><span className="text-sm font-medium">{t.title}</span></div><p className="mt-1 text-xs text-muted">{t.detail}</p></Link></li>
          ))}</ul> : <p className="text-sm text-muted">Nothing unusual found. Anomalies, duplicate bills and overdue clients appear here.</p>}
        </Card>
        <Card title="Profit and loss, this year">
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-muted">Income</dt><dd className="text-end tabular-nums">{m(s.income)}</dd>
            <dt className="text-muted">Expenses</dt><dd className="text-end tabular-nums">{m(s.expense)}</dd>
            <dt className="font-medium">Net profit</dt><dd className={`text-end font-semibold tabular-nums ${s.net.isNegative() ? "text-danger" : "text-ok"}`}>{m(s.net)}</dd>
          </dl>
          <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-surface-2"><div className="h-full brand-grad" style={{ width: `${s.income.isZero() ? 0 : Math.max(0, Math.min(100, s.net.div(s.income).times(100).toNumber()))}%` }} /></div>
          <p className="mt-1 text-xs text-muted">Net margin {s.income.isZero() ? "—" : `${s.net.div(s.income).times(100).toFixed(1)}%`}</p>
          <div className="mt-3 flex flex-wrap gap-2"><Quick href="/accounts/reports?r=pnl">P&L report</Quick><Quick href="/accounts/reports?r=balance-sheet">Balance sheet</Quick></div>
        </Card>
        <Card title="Month-end close" action={<Badge tone={ai.close.pct === 100 ? "ok" : "warn"}>{ai.close.pct}% ready</Badge>}>
          <ul className="space-y-1.5 text-sm">{ai.close.checks.map((c) => <li key={c.label}><Link href={c.href} className="flex items-center justify-between gap-2 hover:underline"><span><span className={c.ok ? "text-ok" : "text-warn"}>{c.ok ? "✓" : "•"}</span> {c.label}</span><span className="text-xs text-muted">{c.detail}</span></Link></li>)}</ul>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Receivables (corporate clients)" action={<Link href="/accounts/sales?tab=invoices" className="text-xs text-primary hover:underline">Invoices →</Link>}>
          <Table head={["Age", "Invoices", "Outstanding"]}>
            {ar.buckets.map((b) => <tr key={b.label}><td>{b.label}</td><td>{b.count}</td><td className="tabular-nums">{m(b.amount)}</td></tr>)}
            <tr className="font-semibold"><td>Total, net of credits</td><td /><td className="tabular-nums">{m(ar.total)}</td></tr>
          </Table>
        </Card>
        <Card title="Payables (supplier bills)" action={<Link href="/accounts/purchases?tab=bills" className="text-xs text-primary hover:underline">Bills →</Link>}>
          {ap ? <Table head={["Age", "Bills", "Outstanding"]}>{ap.buckets.map((b) => <tr key={b.label}><td>{b.label}</td><td>{b.count}</td><td className="tabular-nums">{m(b.amount)}</td></tr>)}<tr className="font-semibold"><td>Total</td><td /><td className="tabular-nums">{m(ap.total)}</td></tr></Table> : <p className="text-sm text-muted">Your role cannot view supplier bills.</p>}
        </Card>
      </div>

      <Card title="Latest ledger activity" action={<Link href="/accounts/accountant?tab=journals" className="text-xs text-primary hover:underline">All journals →</Link>}>
        <Table head={["#", "Date", "Memo", "Source"]} empty={journals.length ? undefined : "No postings yet."}>
          {journals.map((j) => <tr key={j._id}><td className="font-mono text-xs">{j.entryNo}</td><td>{fmtDate(j.date)}</td><td>{j.memo}</td><td className="text-xs capitalize text-muted">{j.sourceRef.type.replace(/_/g, " ")}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}
