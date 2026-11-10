import { requireCtx } from "@/lib/session";
import { parseRange, todayYmd } from "@/lib/range";
import { Alert, Badge, Card, Table, Tabs } from "@/ui/kit";
import { ActionButton, ActionForm, fmtDate, fmtDateTime } from "@/ui/forms";
import { fromDecimal128 } from "@/core/money";
import * as coa from "@/modules/ledger/coa";
import { listJournals } from "@/modules/ledger/journal";
import { listPeriods } from "@/modules/ledger/periods";
import { listDraftJournals } from "@/modules/ledger/drafts";
import { budgetVsActual } from "@/modules/finance/statements";
import { m } from "../_shared";

const TABS = [{ key: "chart", label: "Chart of accounts" }, { key: "journals", label: "Manual journals" }, { key: "budgets", label: "Budgets" }, { key: "lock", label: "Transaction locking" }];
const TYPES = ["asset", "liability", "equity", "income", "expense"] as const;
type C = Awaited<ReturnType<typeof requireCtx>>;
type Has = (p: string) => boolean;

export default async function AccountantPage({ searchParams }: { searchParams: Promise<{ tab?: string; error?: string; notice?: string; from?: string; to?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "chart";
  const back = `/accounts/accountant?tab=${tab}`;
  const has: Has = (p) => ctx.permissions.includes(p as never);
  return (
    <div className="space-y-4">
      {sp.error && <Alert>{sp.error}</Alert>}
      {sp.notice && <Alert tone="ok">{sp.notice}</Alert>}
      <Tabs tabs={TABS} active={tab} base="/accounts/accountant" />
      {tab === "chart" && <Chart ctx={ctx} back={back} has={has} />}
      {tab === "journals" && <Journals ctx={ctx} back={back} has={has} />}
      {tab === "budgets" && <Budgets ctx={ctx} back={back} has={has} sp={sp} />}
      {tab === "lock" && <Lock ctx={ctx} back={back} has={has} />}
    </div>
  );
}

async function Chart({ ctx, back, has }: { ctx: C; back: string; has: Has }) {
  const accounts = await coa.listAccounts(ctx);
  return (
    <>
      {TYPES.map((t) => { const rows = accounts.filter((a) => a.type === t); return (
        <Card key={t} title={<span className="capitalize">{t === "income" ? "Income" : t === "expense" ? "Expenses" : `${t}s`} ({rows.length})</span>}>
          <Table head={["Code", "Account", "Balance (debit +)", "Status", ""]}>
            {rows.map((a) => <tr key={a.code}><td className="font-mono text-xs">{a.code}</td><td>{a.name}{a.system && <span className="ms-1.5 rounded bg-surface-2 px-1.5 text-[10px] text-muted">system</span>}</td><td className="tabular-nums"><a className="hover:underline" href={`/accounts/reports?r=general-ledger&code=${a.code}`}>{m(a.balance)}</a></td>
              <td><Badge tone={a.active ? "ok" : "neutral"}>{a.active ? "active" : "inactive"}</Badge></td>
              <td className="whitespace-nowrap">{has("ledger:approve") && <><details className="inline-block align-top"><summary className="cursor-pointer text-xs text-primary">Rename</summary><div className="mt-2"><ActionForm inline action="coa.rename" back={back} hidden={{ code: a.code }} submit="Save" variant="outline" fields={[{ name: "name", label: "Name", required: true, defaultValue: a.name }]} /></div></details>
                {!a.system && <ActionButton action="coa.active" back={back} hidden={{ code: a.code, active: a.active ? "0" : "1" }} variant="ghost">{a.active ? "Deactivate" : "Activate"}</ActionButton>}</>}</td></tr>)}
          </Table>
        </Card>
      ); })}
      {has("ledger:approve") && <Card id="new" title="New account"><ActionForm action="coa.add" back={back} submit="Add account" fields={[{ name: "code", label: "Code (4 digits: 1 asset, 2 liability, 3 equity, 4 income, 5 expense)", required: true }, { name: "name", label: "Name", required: true }, { name: "type", label: "Type", type: "select", options: [...TYPES] }]} /></Card>}
    </>
  );
}

async function Journals({ ctx, back, has }: { ctx: C; back: string; has: Has }) {
  const [rows, drafts] = await Promise.all([listJournals(ctx, 100), listDraftJournals(ctx)]);
  const pending = drafts.filter((d) => d.status === "pending");
  return (
    <>
      {has("ledger:create") && (
        <Card id="new" title="New manual journal">
          <ActionForm action="journal.manual" back={back} submit="Post journal" fields={[
            { name: "date", label: "Date", type: "date", defaultValue: todayYmd() }, { name: "memo", label: "Narration", required: true, span: 2 },
            { name: "lines", label: "Lines", type: "textarea", required: true, span: 3, hint: "One line per row: account code | debit | credit.  Example:  5200 | 1500 |   then   1010 | | 1500.  Debits must equal credits. Posted journals are never edited, only reversed." }]} />
        </Card>
      )}
      {pending.length > 0 && (
        <Card title={`Awaiting approval (${pending.length})`}>
          <Table head={["Narration", "Submitted", ""]}>{pending.map((d) => <tr key={d._id}><td>{d.input.memo}</td><td className="text-xs">{fmtDateTime(d.createdAt)}</td>
            <td>{has("ledger:approve") && <div className="flex gap-1"><ActionButton action="fin.journalDecide" back={back} hidden={{ id: d._id, decision: "approve" }}>Approve</ActionButton><ActionForm inline action="fin.journalDecide" back={back} hidden={{ id: d._id, decision: "reject" }} submit="Reject" variant="ghost" fields={[{ name: "reason", label: "Reason" }]} /></div>}</td></tr>)}</Table>
        </Card>
      )}
      <Card title="Journal entries">
        <Table head={["#", "Date", "Narration", "Source", "Amount", ""]} empty={rows.length ? undefined : "No entries yet."}>
          {rows.map((r) => { const amt = r.lines.reduce((a, l) => a.plus(fromDecimal128(l.debit)), fromDecimal128("0")); return (
            <tr key={r._id}><td className="font-mono text-xs">{r.entryNo}</td><td>{fmtDate(r.date)}</td><td>{r.memo} {r.reversalOf && <Badge tone="warn">reversal</Badge>} {r.reversed && <Badge tone="neutral">reversed</Badge>}</td>
              <td className="text-xs capitalize text-muted">{r.sourceRef.type.replace(/_/g, " ")}</td><td className="tabular-nums">{m(amt)}</td>
              <td>{has("ledger:approve") && !r.reversed && !r.reversalOf && <details className="inline-block align-top"><summary className="cursor-pointer text-xs text-danger">Reverse</summary><div className="mt-2"><ActionForm inline action="acc.reverse" back={back} hidden={{ entryId: r._id }} submit="Post reversal" variant="danger" fields={[{ name: "reason", label: "Reason", required: true }]} /></div></details>}</td></tr>); })}
        </Table>
      </Card>
    </>
  );
}

async function Budgets({ ctx, back, has, sp }: { ctx: C; back: string; has: Has; sp: { from?: string; to?: string } }) {
  const year = new Date().getFullYear();
  const { from, to, fromStr, toStr } = parseRange({ from: sp.from ?? `${year}-01-01`, to: sp.to });
  const bva = await budgetVsActual(ctx, { from, to });
  return (
    <>
      <Card title="Budget vs actual" action={<form className="flex items-end gap-2 text-sm"><input type="hidden" name="tab" value="budgets" /><input name="from" type="date" defaultValue={fromStr} aria-label="From" className="rounded-ui border border-border bg-surface px-2 py-1" /><input name="to" type="date" defaultValue={toStr} aria-label="To" className="rounded-ui border border-border bg-surface px-2 py-1" /><button className="rounded-ui border border-border px-3 py-1">Apply</button></form>}>
        <Table head={["Account", "Budget (pro-rated)", "Actual", "Variance", "Used"]} empty="No budgets or activity in this period.">
          {bva.rows.map((r) => { const pct = r.budget.isZero() ? null : r.actual.div(r.budget).times(100).toNumber(); return (
            <tr key={r.code}><td className="font-mono text-xs">{r.code}</td><td className="tabular-nums">{m(r.budget)}</td><td className="tabular-nums">{m(r.actual)}</td><td className={`tabular-nums ${r.code.startsWith("5") && r.variance.gt(0) ? "text-danger" : ""}`}>{m(r.variance)}</td>
              <td className="w-40">{pct === null ? <span className="text-xs text-muted">no budget</span> : <div className="h-2 overflow-hidden rounded-full bg-surface-2"><div className={`h-full ${pct > 100 && r.code.startsWith("5") ? "bg-danger" : "brand-grad"}`} style={{ width: `${Math.min(100, pct)}%` }} /></div>}</td></tr>); })}
        </Table>
      </Card>
      {has("reports:create") && <Card title="Set an annual budget"><ActionForm action="fin.budget" back={back} submit="Save budget" fields={[{ name: "year", label: "Year", type: "number", required: true, defaultValue: year }, { name: "code", label: "Account code", required: true, placeholder: "5700" }, { name: "amount", label: "Annual amount (AED)", required: true }]} /></Card>}
    </>
  );
}

async function Lock({ ctx, back, has }: { ctx: C; back: string; has: Has }) {
  const ps = await listPeriods(ctx);
  const locked = ps.filter((p) => p.status === "locked");
  const last = locked[locked.length - 1];
  return (
    <>
      <Card title="Transaction lock date">
        <p className="text-sm">{last ? <>Books are locked through <b>{last.year}-{String(last.month).padStart(2, "0")}</b>. Nobody can post, edit or reverse into a locked month.</> : "No months are locked yet."}</p>
        {has("ledger:approve") && <div className="mt-3"><ActionForm action="bk.lockThrough" back={back} inline submit="Lock through" variant="danger" fields={[{ name: "year", label: "Year", type: "number", required: true, defaultValue: new Date().getFullYear() }, { name: "month", label: "Month (1-12)", type: "number", required: true }]} /></div>}
      </Card>
      <Card title="Fiscal periods">
        <Table head={["Period", "Status", ""]}>
          {[...ps].reverse().map((p) => <tr key={p._id}><td>{p.year}-{String(p.month).padStart(2, "0")}</td><td><Badge tone={p.status === "open" ? "ok" : "neutral"}>{p.status}</Badge></td>
            <td>{has("ledger:approve") && p.status === "open" && <ActionButton action="acc.lockPeriod" back={back} hidden={{ year: p.year, month: p.month }} variant="ghost">Lock</ActionButton>}</td></tr>)}
        </Table>
      </Card>
    </>
  );
}
