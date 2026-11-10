import { requireCtx } from "@/lib/session";
import { parseRange } from "@/lib/range";
import { Alert, Badge, Button, Card, Input, NoAccess, PageHeader, Stat, Table, Tabs, aed } from "@/ui/kit";
import { ActionButton, ActionForm, fmtDateTime } from "@/ui/forms";
import { bankReconciliation, gatewayUnsettled, listRegisterSessions } from "@/modules/finance/cashbank";
import { balanceSheet, branchProfitability, budgetVsActual, cashFlow, pharmacyMargin, vatSummary } from "@/modules/finance/statements";
import { listDraftJournals } from "@/modules/ledger/drafts";
import { fromDecimal128 } from "@/core/money";

const TABS = [{ key: "statements", label: "Statements" }, { key: "cash", label: "Cash & drawers" }, { key: "bank", label: "Bank & cards" }, { key: "budget", label: "Budget & branches" }, { key: "journals", label: "Journals & close" }];

export default async function FinancePage({ searchParams }: { searchParams: Promise<{ tab?: string; error?: string; from?: string; to?: string; account?: string; end?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  if (!ctx.permissions.includes("reports:view")) return <NoAccess what="finance reports" />;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "statements";
  const back = `/finance?tab=${tab}`;
  const can = (p: string) => ctx.permissions.includes(p as never);
  const { from, to, fromStr, toStr } = parseRange(sp);

  return (
    <div className="space-y-4">
      <PageHeader title="Finance" sub="Financial statements, cash and bank control, budgets, journal approval and period close. All figures come from the ledger."
        actions={(tab === "statements" || tab === "budget") && <form className="flex items-end gap-2"><input type="hidden" name="tab" value={tab} /><Input name="from" type="date" defaultValue={fromStr} aria-label="From" /><Input name="to" type="date" defaultValue={toStr} aria-label="To" /><Button variant="outline">Apply</Button></form>} />
      {sp.error && <Alert>{sp.error}</Alert>}
      <Tabs tabs={TABS} active={tab} base="/finance" />
      {tab === "statements" && <Statements ctx={ctx} from={from} to={to} />}
      {tab === "cash" && <Cash ctx={ctx} back={back} can={can} />}
      {tab === "bank" && <Bank ctx={ctx} back={back} can={can} account={(sp.account as "bank" | "bank_savings") ?? "bank"} end={sp.end} />}
      {tab === "budget" && <Budget ctx={ctx} back={back} can={can} from={from} to={to} />}
      {tab === "journals" && <Journals ctx={ctx} back={back} can={can} />}
    </div>
  );
}
type C = Awaited<ReturnType<typeof requireCtx>>;
type Can = (p: string) => boolean;
const m = (d: { toFixed: (n: number) => string }) => aed(d.toFixed(2));

async function Statements({ ctx, from, to }: { ctx: C; from: Date; to: Date }) {
  const [bs, cf, vat] = await Promise.all([balanceSheet(ctx, { asOf: new Date(to.getTime() - 1) }), cashFlow(ctx, { from, to }), vatSummary(ctx, { from, to })]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Balance sheet" action={<Badge tone={bs.balanced ? "ok" : "danger"}>{bs.balanced ? "Balanced" : "OUT OF BALANCE"}</Badge>}>
        <Table head={["Account", "Amount"]}>
          <tr className="bg-surface-2 font-medium"><td colSpan={2}>Assets</td></tr>{bs.assets.map((a) => <tr key={a.code}><td>{a.code} {a.name}</td><td className="tabular-nums">{a.amount.toFixed(2)}</td></tr>)}
          <tr className="bg-surface-2 font-medium"><td colSpan={2}>Liabilities</td></tr>{bs.liabilities.map((a) => <tr key={a.code}><td>{a.code} {a.name}</td><td className="tabular-nums">{a.amount.toFixed(2)}</td></tr>)}
          <tr className="bg-surface-2 font-medium"><td colSpan={2}>Equity</td></tr>{bs.equity.map((a) => <tr key={a.code}><td>{a.code} {a.name}</td><td className="tabular-nums">{a.amount.toFixed(2)}</td></tr>)}
          <tr><td>Current earnings</td><td className="tabular-nums">{bs.currentEarnings.toFixed(2)}</td></tr>
          <tr className="font-semibold"><td>Total assets</td><td className="tabular-nums">{bs.totalAssets.toFixed(2)}</td></tr><tr className="font-semibold"><td>Liabilities + equity</td><td className="tabular-nums">{bs.totalLiabilitiesAndEquity.toFixed(2)}</td></tr>
        </Table>
      </Card>
      <div className="space-y-4">
        <Card title="Cash flow (direct method)" action={<Badge tone={cf.reconciles ? "ok" : "danger"}>{cf.reconciles ? "Reconciles to cash" : "Does not reconcile"}</Badge>}>
          <dl className="grid grid-cols-2 gap-y-1 text-sm"><dt>Opening cash</dt><dd className="text-end tabular-nums">{m(cf.opening)}</dd><dt>Operating</dt><dd className="text-end tabular-nums">{m(cf.operating)}</dd><dt>Investing</dt><dd className="text-end tabular-nums">{m(cf.investing)}</dd><dt>Financing</dt><dd className="text-end tabular-nums">{m(cf.financing)}</dd><dt className="font-semibold">Closing cash</dt><dd className="text-end font-semibold tabular-nums">{m(cf.closing)}</dd></dl>
          <p className="mt-2 text-xs text-muted">Cash includes cash, bank, petty cash and card settlements in transit.</p>
        </Card>
        <Card title="VAT summary">
          <dl className="grid grid-cols-2 gap-y-1 text-sm"><dt>Output VAT</dt><dd className="text-end tabular-nums">{m(vat.outputVat)}</dd><dt>Input VAT</dt><dd className="text-end tabular-nums">{m(vat.inputVat)}</dd><dt className="font-semibold">Net payable</dt><dd className="text-end font-semibold tabular-nums">{m(vat.netPayable)}</dd></dl>
          <p className="mt-2 text-xs text-muted">Supplies by class: {Object.entries(vat.suppliesByClass).map(([k, v]) => `${k} ${m(v)}`).join(" · ") || "none"}</p>
          <p className="mt-1 text-xs text-warn">{vat.note}</p>
        </Card>
      </div>
    </div>
  );
}

async function Cash({ ctx, back, can }: { ctx: C; back: string; can: Can }) {
  const sessions = await listRegisterSessions(ctx);
  const mine = sessions.find((s) => s.cashierId === ctx.userId && s.status === "open");
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="My cash drawer">
          {mine ? <><p className="mb-2 text-sm">Open since {fmtDateTime(mine.openedAt)} · float {aed(fromDecimal128(mine.openingFloat).toFixed(2))}</p>{can("billing:create") && <ActionForm action="fin.closeRegister" back={back} submit="Close drawer" fields={[{ name: "counted", label: "Counted cash (AED)", required: true }, { name: "note", label: "Note (required if there is a variance)" }]} />}</> : can("billing:create") ? <ActionForm action="fin.openRegister" back={back} submit="Open drawer" fields={[{ name: "float", label: "Opening float (AED)", required: true, defaultValue: "0.00" }]} /> : <p className="text-sm text-muted">You do not take payments.</p>}
        </Card>
        {can("ledger:create") && <Card title="Transfers and petty cash"><div className="space-y-3"><ActionForm action="fin.transfer" back={back} submit="Transfer" variant="outline" fields={[{ name: "from", label: "From", type: "select", options: ["cash", "bank", "bank_savings", "petty_cash"] }, { name: "to", label: "To", type: "select", defaultValue: "bank", options: ["cash", "bank", "bank_savings", "petty_cash"] }, { name: "amount", label: "Amount", required: true }]} /><ActionForm action="fin.petty" back={back} submit="Record petty-cash expense" variant="outline" fields={[{ name: "code", label: "Expense account code", required: true, defaultValue: "5800" }, { name: "amount", label: "Amount", required: true }, { name: "description", label: "What for", required: true }]} /></div></Card>}
      </div>
      <Card title="Drawer sessions"><Table head={["Cashier", "Opened", "Closed", "Expected", "Counted", "Variance"]} empty="No sessions.">{sessions.map((s) => <tr key={s._id}><td className="font-mono text-xs">{s.cashierId.slice(-6)}</td><td className="text-xs">{fmtDateTime(s.openedAt)}</td><td className="text-xs">{s.closedAt ? fmtDateTime(s.closedAt) : <Badge tone="info">open</Badge>}</td><td>{s.expected ? fromDecimal128(s.expected).toFixed(2) : "—"}</td><td>{s.counted ? fromDecimal128(s.counted).toFixed(2) : "—"}</td><td className={s.variance && !fromDecimal128(s.variance).isZero() ? "text-danger" : ""}>{s.variance ? fromDecimal128(s.variance).toFixed(2) : "—"}</td></tr>)}</Table></Card>
    </>
  );
}

async function Bank({ ctx, back, can, account, end }: { ctx: C; back: string; can: Can; account: "bank" | "bank_savings"; end?: string }) {
  const [unsettled, rec] = await Promise.all([gatewayUnsettled(ctx), end ? bankReconciliation(ctx, { account, statementEndBalance: end }).catch(() => null) : null]);
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3"><Stat label="Card payments awaiting settlement" value={m(unsettled)} /></div>
      <div className="grid gap-4 lg:grid-cols-2">
        {can("ledger:create") && <Card title="Import bank statement"><ActionForm action="fin.importBank" back={back} submit="Import" fields={[{ name: "account", label: "Account", type: "select", options: ["bank", "bank_savings"] }, { name: "csv", label: "Lines: date,description,amount,reference (one per line, + in / − out)", type: "textarea", required: true, span: 3, placeholder: "2026-11-03,Cash deposit,1500.00,DEP1" }]} /><div className="mt-3 border-t border-border pt-3"><ActionForm inline action="fin.autoMatch" back={back} submit="Auto-match" variant="outline" fields={[{ name: "account", label: "Account", type: "select", options: ["bank", "bank_savings"] }]} /></div></Card>}
        {can("ledger:create") && <Card title="Card settlement"><ActionForm action="fin.card" back={back} submit="Record settlement" fields={[{ name: "reference", label: "Acquirer reference", required: true }, { name: "gross", label: "Gross AED", required: true }, { name: "fees", label: "Fees AED", defaultValue: "0" }]} /></Card>}
      </div>
      <Card title="Bank reconciliation">
        <form className="flex flex-wrap items-end gap-2"><input type="hidden" name="tab" value="bank" /><select name="account" defaultValue={account} className="rounded-ui border border-border bg-surface px-3 py-2 text-sm"><option value="bank">bank</option><option value="bank_savings">bank_savings</option></select><Input name="end" defaultValue={end} placeholder="Statement closing balance" className="w-56" /><Button variant="outline">Reconcile</Button></form>
        {rec && <div className="mt-3 space-y-2 text-sm"><p>Ledger balance <strong>{m(rec.glBalance)}</strong> · Statement <strong>{m(rec.statementBalance)}</strong> · {rec.reconciled ? <Badge tone="ok">Fully explained</Badge> : <Badge tone="danger">Unexplained {m(rec.unexplainedDifference)}</Badge>}</p><div className="grid gap-3 lg:grid-cols-2"><Table head={["On statement, not in books", "Amount"]} empty="None.">{rec.unmatchedStatement.map((t) => <tr key={t._id}><td className="text-xs">{t.description}</td><td>{fromDecimal128(t.amount).toFixed(2)}</td></tr>)}</Table><div className="text-xs text-muted">In books, not yet on statement: {m(rec.inTransit)} ({rec.unmatchedGl.length} line(s))</div></div></div>}
      </Card>
    </>
  );
}

async function Budget({ ctx, back, can, from, to }: { ctx: C; back: string; can: Can; from: Date; to: Date }) {
  const [bva, br, pm] = await Promise.all([budgetVsActual(ctx, { from, to }), branchProfitability(ctx, { from, to }), pharmacyMargin(ctx, { from, to })]);
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Budget vs actual (pro-rated)"><Table head={["Account", "Budget", "Actual", "Variance"]} empty="No budget or activity.">{bva.rows.map((r) => <tr key={r.code}><td className="font-mono text-xs">{r.code}</td><td>{r.budget.toFixed(2)}</td><td>{r.actual.toFixed(2)}</td><td className={r.variance.isNegative() ? "text-danger" : ""}>{r.variance.toFixed(2)}</td></tr>)}</Table></Card>
        <div className="space-y-4">
          <Card title="Branch profitability"><Table head={["Branch", "Income", "Expense", "Net"]}>{br.rows.map((r) => <tr key={r.branchId}><td>{r.name}</td><td>{r.income.toFixed(2)}</td><td>{r.expense.toFixed(2)}</td><td>{r.net.toFixed(2)}</td></tr>)}<tr className="text-muted"><td colSpan={3}>Not assigned to a branch</td><td>{br.unassignedNet.toFixed(2)}</td></tr></Table></Card>
          <Card title="Pharmacy gross margin"><p className="text-sm">Revenue {m(pm.revenue)} · COGS {m(pm.cogs)} · margin <strong>{m(pm.grossMargin)}</strong>{pm.marginPct !== null && ` (${pm.marginPct.toFixed(1)}%)`}</p></Card>
        </div>
      </div>
      {can("reports:create") && <Card title="Set annual budget"><ActionForm action="fin.budget" back={back} submit="Save" fields={[{ name: "year", label: "Year", type: "number", required: true, defaultValue: new Date().getFullYear() }, { name: "code", label: "Account code", required: true, placeholder: "4000" }, { name: "amount", label: "Annual amount (AED)", required: true }]} /></Card>}
    </>
  );
}

async function Journals({ ctx, back, can }: { ctx: C; back: string; can: Can }) {
  const rows = await listDraftJournals(ctx);
  const now = new Date(Date.now() + 4 * 3600_000);
  return (
    <>
      <Card title="Journals awaiting approval"><Table head={["Memo", "Submitted", "Status", ""]} empty="None.">{rows.map((d) => <tr key={d._id}><td>{d.input.memo}</td><td className="text-xs">{fmtDateTime(d.createdAt)}</td><td><Badge tone={d.status === "approved" ? "ok" : d.status === "rejected" ? "danger" : "warn"}>{d.status}</Badge></td><td>{d.status === "pending" && can("ledger:approve") && <div className="flex gap-1"><ActionButton action="fin.journalDecide" back={back} hidden={{ id: d._id, decision: "approve" }}>Approve</ActionButton><ActionForm inline action="fin.journalDecide" back={back} hidden={{ id: d._id, decision: "reject" }} submit="Reject" variant="ghost" fields={[{ name: "reason", label: "Reason" }]} /></div>}</td></tr>)}</Table><p className="mt-2 text-xs text-muted">The submitter cannot approve their own journal.</p></Card>
      <div className="grid gap-4 lg:grid-cols-2">
        {can("ledger:create") && <Card title="Submit adjusting journal"><ActionForm action="fin.journalSubmit" back={back} submit="Submit for approval" fields={[{ name: "date", label: "Date", type: "date", required: true }, { name: "memo", label: "Memo", required: true }, { name: "debitCode", label: "Debit account code", required: true }, { name: "creditCode", label: "Credit account code", required: true }, { name: "amount", label: "Amount (AED)", required: true }]} /></Card>}
        {can("ledger:approve") && <Card title="Period close"><div className="space-y-3"><ActionForm action="fin.closePeriod" back={back} submit="Lock period" variant="outline" fields={[{ name: "year", label: "Year", type: "number", required: true, defaultValue: now.getUTCFullYear() }, { name: "month", label: "Month", type: "number", required: true, defaultValue: now.getUTCMonth() + 1 }]} /><ActionForm action="fin.closeYear" back={back} submit="Close fiscal year" variant="danger" fields={[{ name: "year", label: "Year", type: "number", required: true, defaultValue: now.getUTCFullYear() }]} /><p className="text-xs text-muted">Year-end close moves net income to retained earnings and locks all periods. It cannot be undone.</p></div></Card>}
      </div>
    </>
  );
}
