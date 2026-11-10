import Link from "next/link";
import { requireCtx } from "@/lib/session";
import { Badge, Button, Card, Input, NoAccess, Table } from "@/ui/kit";
import { fmtDate } from "@/ui/forms";
import { askBooks, categorise, cfoInsights } from "@/modules/accounts/insights";
import { AiTag, ForecastChart, MiniBars, ScoreRing, num } from "../_shared";

const SUGGESTED = ["How much did we spend on rent last quarter?", "What was our profit last month?", "Who owes us money?", "Top expenses this year", "Top clients this year", "How long will our cash last?", "What is our VAT payable?"];

export default async function AiCfoPage({ searchParams }: { searchParams: Promise<{ q?: string; cat?: string }> }) {
  const ctx = await requireCtx();
  if (!ctx.permissions.includes("reports:view")) return <NoAccess what="the AI CFO" />;
  const sp = await searchParams;
  const [ai, answer, suggestion] = await Promise.all([
    cfoInsights(ctx),
    sp.q?.trim() ? askBooks(ctx, sp.q) : Promise.resolve(null),
    sp.cat?.trim() ? categorise(ctx, sp.cat) : Promise.resolve(null),
  ]);
  const monthLabels = ai.monthly.map((_, i) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - (ai.monthly.length - i)); return d.toLocaleDateString("en-GB", { month: "short" }); });

  return (
    <div className="space-y-4">
      <div className="relative overflow-hidden rounded-[var(--radius-ui,14px)] brand-grad p-6 text-white shadow-card">
        <div className="relative z-10 grid gap-5 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-white/75">✦ AI CFO</p>
            <h2 className="mt-1 text-2xl font-semibold">Ask your books anything</h2>
            <form className="mt-3 flex max-w-2xl gap-2" action="/accounts/ai">
              <Input name="q" defaultValue={sp.q} placeholder="e.g. How much did we spend on marketing last quarter?" className="flex-1 !bg-white/95 !text-[#0b3558]" aria-label="Question about your books" />
              <Button className="!bg-white !text-[#0b3558]">Ask</Button>
            </form>
            <div className="mt-2 flex flex-wrap gap-1.5">{SUGGESTED.map((q) => <Link key={q} href={`/accounts/ai?q=${encodeURIComponent(q)}`} className="rounded-full bg-white/15 px-2.5 py-1 text-xs hover:bg-white/25">{q}</Link>)}</div>
          </div>
          <div className="text-end text-xs text-white/75">Runs on your own ledger.<br />Nothing leaves Elister.</div>
        </div>
      </div>

      {answer && (
        <Card title={<span className="flex items-center gap-2">Answer <AiTag /></span>}>
          <p className="text-lg">{answer.answer}</p>
          {answer.rows && answer.rows.length > 0 && <div className="mt-3"><Table head={["", "Amount"]}>{answer.rows.map((r) => <tr key={r.label}><td>{r.label}</td><td className="tabular-nums">{num(r.amount)}</td></tr>)}</Table></div>}
          <p className="mt-2 text-xs text-muted">How this was worked out: {answer.method}</p>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={<span className="flex items-center gap-2">Financial health score <AiTag /></span>}>
          <div className="flex justify-center"><ScoreRing score={ai.health.score} label={ai.health.grade} /></div>
          <ul className="mt-4 space-y-3">{ai.health.factors.map((f) => (
            <li key={f.key}>
              <div className="flex justify-between text-sm"><span className="font-medium">{f.label}</span><span className="tabular-nums">{f.display}</span></div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2"><div className="h-full brand-grad" style={{ width: `${(f.score / 25) * 100}%` }} /></div>
              <p className="mt-1 text-xs text-muted">{f.note}</p>
            </li>
          ))}</ul>
        </Card>
        <Card className="lg:col-span-2" title={<span className="flex items-center gap-2">13-week cash forecast <AiTag>Forecast</AiTag></span>}
          action={ai.forecast.breachWeek ? <Badge tone="danger">Shortfall in week {ai.forecast.breachWeek}</Badge> : <Badge tone="ok">No shortfall</Badge>}>
          <ForecastChart points={ai.forecast.points} opening={ai.summary.cash.toNumber()} />
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <div><p className="mb-2 text-xs font-medium text-muted">Net cash movement, recent months</p>{ai.monthly.length ? <MiniBars values={ai.monthly} labels={monthLabels} /> : <p className="text-xs text-muted">No history yet.</p>}</div>
            <ul className="list-disc space-y-1 ps-4 text-xs text-muted">{ai.forecast.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
          </div>
          <details className="mt-3"><summary className="cursor-pointer text-xs text-primary">Week-by-week table</summary>
            <div className="mt-2"><Table head={["Week of", "Money in", "Money out", "Expected cash", "Range"]}>{ai.forecast.points.map((p) => <tr key={p.week}><td>{fmtDate(p.start)}</td><td className="tabular-nums">{num(p.inflow)}</td><td className="tabular-nums">{num(p.outflow)}</td><td className={`tabular-nums ${p.expected < 0 ? "text-danger" : ""}`}>{num(p.expected)}</td><td className="text-xs tabular-nums text-muted">{p.low.toFixed(0)} – {p.high.toFixed(0)}</td></tr>)}</Table></div>
          </details>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card id="anomalies" title={<span className="flex items-center gap-2">Unusual spending <AiTag>Anomaly watch</AiTag></span>}>
          {ai.anomalies.length ? <ul className="space-y-2">{ai.anomalies.slice(0, 10).map((a) => (
            <li key={a.id} className="rounded-ui border border-border p-3"><div className="flex items-center gap-2"><Badge tone={a.severity === "high" ? "danger" : "warn"}>{a.kind === "spike" ? "Spike" : "Outlier"}</Badge><span className="text-sm font-medium">{a.title}</span>{a.date && <span className="ms-auto text-xs text-muted">{fmtDate(a.date)}</span>}</div>
              <p className="mt-1 text-xs text-muted">{a.detail}</p><Link className="mt-1 inline-block text-xs text-primary hover:underline" href={`/accounts/reports?r=general-ledger&code=${a.accountCode}`}>See the ledger for {a.accountCode} →</Link></li>
          ))}</ul> : <p className="text-sm text-muted">No unusual expense postings in the last 30 days. Each posting is compared with that account&apos;s own history.</p>}
        </Card>
        <Card id="duplicates" title={<span className="flex items-center gap-2">Possible duplicate payments <AiTag>Duplicate guard</AiTag></span>}>
          {ai.duplicates.length ? <Table head={["Vendor", "First", "Second", "Why"]}>{ai.duplicates.map((d) => <tr key={`${d.a.id}-${d.b.id}`}><td>{d.a.vendor}</td><td className="text-xs">{d.a.source} · {fmtDate(d.a.date)} · {num(d.a.amount)}</td><td className="text-xs">{d.b.source} · {fmtDate(d.b.date)} · {num(d.b.amount)}</td><td className="text-xs">{d.reason}</td></tr>)}</Table>
            : <p className="text-sm text-muted">No look-alike expenses or bills in the last 90 days (same vendor and amount within a week, or the same reference twice).</p>}
        </Card>
      </div>

      <Card id="collections" title={<span className="flex items-center gap-2">Who to chase first <AiTag>Collections</AiTag></span>}>
        {ai.collections.length ? <Table head={["Client", "Invoice", "Balance", "Overdue", "Suggested step", "Draft message"]}>
          {ai.collections.map((c) => <tr key={c.id}><td>{c.customer}</td><td className="font-mono text-xs">{c.number}</td><td className="tabular-nums">{num(c.balance)}</td><td>{c.daysOverdue > 0 ? `${c.daysOverdue} days` : "not due"}</td>
            <td><Badge tone={c.stage === "Final notice" ? "danger" : c.stage === "Firm follow-up" ? "warn" : "info"}>{c.stage}</Badge></td>
            <td><details><summary className="cursor-pointer text-xs text-primary">View draft</summary><p className="mt-1 max-w-md select-all rounded bg-surface-2 p-2 text-xs">{c.message}</p>
              {c.email && <a className="text-xs text-primary hover:underline" href={`mailto:${c.email}?subject=${encodeURIComponent(`Invoice ${c.number}`)}&body=${encodeURIComponent(c.message)}`}>Open in email</a>}</details></td></tr>)}
        </Table> : <p className="text-sm text-muted">No open corporate invoices.</p>}
        <p className="mt-2 text-xs text-muted">Ranked by money at risk: balance × the chance it is not collected at its age. Drafts are suggestions; nothing is sent automatically.</p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card id="smart" title={<span className="flex items-center gap-2">Smart categorise <AiTag /></span>}>
          <form className="flex gap-2" action="/accounts/ai"><Input name="cat" defaultValue={sp.cat} placeholder="Paste a receipt line, e.g. DEWA October bill" className="flex-1" aria-label="Expense description" /><Button variant="outline">Suggest</Button></form>
          {sp.cat && (suggestion ? <p className="mt-3 text-sm">Post to <b>{suggestion.code}</b> <Badge tone="info">{Math.round(suggestion.confidence * 100)}% confident</Badge> <span className="text-xs text-muted">{suggestion.why}</span> · <Link className="text-primary hover:underline" href={`/accounts/purchases?tab=expenses&category=${suggestion.code}&desc=${encodeURIComponent(sp.cat)}#new`}>Record it</Link></p> : <p className="mt-3 text-sm text-muted">No confident suggestion. Pick the account yourself; future suggestions learn from it.</p>)}
          <p className="mt-2 text-xs text-muted">Learns from how your team categorised earlier expenses, then falls back to common UAE vendors and keywords.</p>
        </Card>
        <Card title="Month-end close assistant" action={<Badge tone={ai.close.pct === 100 ? "ok" : "warn"}>{ai.close.pct}% ready</Badge>}>
          <div className="mb-3 h-2 overflow-hidden rounded-full bg-surface-2"><div className="h-full brand-grad" style={{ width: `${ai.close.pct}%` }} /></div>
          <ul className="space-y-1.5 text-sm">{ai.close.checks.map((c) => <li key={c.label}><Link href={c.href} className="flex items-center justify-between gap-2 hover:underline"><span><span className={c.ok ? "text-ok" : "text-warn"}>{c.ok ? "✓" : "•"}</span> {c.label}</span><span className="text-xs text-muted">{c.detail}</span></Link></li>)}</ul>
        </Card>
      </div>
      <p className="text-xs text-muted">AI CFO uses transparent, rule-based models on your own ledger (no external AI provider). Figures are estimates to support decisions, not audited statements. Generated {fmtDate(ai.generatedAt)}.</p>
    </div>
  );
}
