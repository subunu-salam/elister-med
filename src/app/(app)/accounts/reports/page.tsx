import Link from "next/link";
import Decimal from "decimal.js";
import { requireCtx } from "@/lib/session";
import { parseRange } from "@/lib/range";
import { tenantCol } from "@/core/db";
import { fromDecimal128, money } from "@/core/money";
import { Badge, Card, NoAccess, Table, cn } from "@/ui/kit";
import { fmtDate } from "@/ui/forms";
import { ReportTools } from "@/ui/accounts/ReportTools";
import * as coa from "@/modules/ledger/coa";
import { pnl } from "@/modules/reports/pnl";
import { trialBalance } from "@/modules/reports/trialBalance";
import { arAging } from "@/modules/reports/arAging";
import { balanceSheet, cashFlow, vatSummary } from "@/modules/finance/statements";
import { listExpenses } from "@/modules/finance/expenses";
import { listJournals } from "@/modules/ledger/journal";
import * as bk from "@/modules/books/service";
import { apAging, listSupplierInvoices, listSuppliers } from "@/modules/procurement/service";
import { m } from "../_shared";

const GROUPS: { title: string; items: [string, string][] }[] = [
  { title: "Business overview", items: [["pnl", "Profit and loss"], ["balance-sheet", "Balance sheet"], ["cash-flow", "Cash flow statement"]] },
  { title: "Sales", items: [["sales-customer", "Sales by customer"], ["sales-item", "Sales by item"]] },
  { title: "Receivables", items: [["ar-aging", "AR aging summary"], ["customer-balances", "Customer balances"]] },
  { title: "Payables", items: [["ap-aging", "AP aging summary"], ["vendor-balances", "Vendor balances"]] },
  { title: "Purchases and expenses", items: [["expenses", "Expenses by category"]] },
  { title: "Accountant", items: [["trial-balance", "Trial balance"], ["general-ledger", "General ledger"], ["journal", "Journal report"]] },
  { title: "Taxes", items: [["vat", "VAT summary"]] },
];
const ALL = GROUPS.flatMap((g) => g.items);
const DATED = new Set(["pnl", "cash-flow", "sales-customer", "sales-item", "expenses", "trial-balance", "general-ledger", "journal", "vat"]);
type C = Awaited<ReturnType<typeof requireCtx>>;
type R = { from: Date; to: Date };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ r?: string; from?: string; to?: string; code?: string; compare?: string }> }) {
  const ctx = await requireCtx();
  if (!ctx.permissions.includes("reports:view")) return <NoAccess what="accounting reports" />;
  const sp = await searchParams;
  const r = ALL.some(([k]) => k === sp.r) ? sp.r! : null;
  const year = new Date().getFullYear();
  const range = parseRange({ from: sp.from ?? `${year}-01-01`, to: sp.to });
  const title = ALL.find(([k]) => k === r)?.[1];

  if (!r) return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {GROUPS.map((g) => <Card key={g.title} title={g.title}><ul className="space-y-1.5 text-sm">{g.items.map(([k, l]) => <li key={k}><Link className="text-primary hover:underline" href={`/accounts/reports?r=${k}`}>{l}</Link></li>)}</ul></Card>)}
      <Card title="More"><ul className="space-y-1.5 text-sm"><li><Link className="text-primary hover:underline" href="/accounts/accountant?tab=budgets">Budget vs actual</Link></li><li><Link className="text-primary hover:underline" href="/tax">Corporate tax and fixed assets</Link></li><li><Link className="text-primary hover:underline" href="/finance?tab=budget">Branch profitability</Link></li></ul></Card>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
        <div><Link href="/accounts/reports" className="text-xs text-primary hover:underline">← All reports</Link><h2 className="text-lg font-semibold">{title}</h2></div>
        <div className="flex flex-wrap items-end gap-2">
          {(DATED.has(r) || r === "balance-sheet") && (
            <form className="flex flex-wrap items-end gap-2 text-sm"><input type="hidden" name="r" value={r} />{sp.code && <input type="hidden" name="code" value={sp.code} />}
              {r !== "balance-sheet" && <input name="from" type="date" defaultValue={range.fromStr} aria-label="From" className="rounded-ui border border-border bg-surface px-2 py-1.5" />}
              <input name="to" type="date" defaultValue={range.toStr} aria-label={r === "balance-sheet" ? "As of" : "To"} className="rounded-ui border border-border bg-surface px-2 py-1.5" />
              {r === "pnl" && <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="compare" value="1" defaultChecked={sp.compare === "1"} /> Compare previous period</label>}
              <button className="rounded-ui border border-border px-3 py-1.5">Run</button></form>
          )}
          <ReportTools name={`${r}-${range.toStr}`} />
        </div>
      </div>
      <p className="hidden text-sm print:block">{title} · {DATED.has(r) ? `${range.fromStr} to ${range.toStr}` : `as of ${range.toStr}`}</p>
      <div data-report>
        {r === "pnl" && <Pnl ctx={ctx} f={range} compare={sp.compare === "1"} />}
        {r === "balance-sheet" && <Bs ctx={ctx} asOf={new Date(range.to.getTime() - 1)} />}
        {r === "cash-flow" && <Cf ctx={ctx} f={range} />}
        {r === "sales-customer" && <SalesBy ctx={ctx} f={range} by="customer" />}
        {r === "sales-item" && <SalesBy ctx={ctx} f={range} by="item" />}
        {r === "ar-aging" && <ArAging ctx={ctx} />}
        {r === "customer-balances" && <CustBal ctx={ctx} />}
        {r === "ap-aging" && <ApAging ctx={ctx} />}
        {r === "vendor-balances" && <VendBal ctx={ctx} />}
        {r === "expenses" && <Expenses ctx={ctx} f={range} />}
        {r === "trial-balance" && <Tb ctx={ctx} f={range} />}
        {r === "general-ledger" && <Gl ctx={ctx} f={range} code={sp.code} fromStr={range.fromStr} toStr={range.toStr} />}
        {r === "journal" && <Journal ctx={ctx} f={range} />}
        {r === "vat" && <Vat ctx={ctx} f={range} />}
      </div>
    </div>
  );
}

const pct = (a: Decimal, b: Decimal) => (b.isZero() ? "—" : `${a.minus(b).div(b.abs()).times(100).toFixed(1)}%`);

async function Pnl({ ctx, f, compare }: { ctx: C; f: R; compare: boolean }) {
  const len = f.to.getTime() - f.from.getTime();
  const [cur, prev, accs] = await Promise.all([pnl(ctx, f), compare ? pnl(ctx, { from: new Date(f.from.getTime() - len), to: f.from }) : Promise.resolve(null), coa.listAccounts(ctx)]);
  const name = new Map(accs.map((a) => [a.code, a.name]));
  const p = new Map(prev?.byAccount.map((a) => [a.code, a.amount]) ?? []);
  const head = ["Account", "Amount", ...(compare ? ["Previous period", "Change"] : [])];
  const row = (code: string, amt: Decimal) => <tr key={code}><td><a className="hover:underline" href={`/accounts/reports?r=general-ledger&code=${code}`}>{code} {name.get(code)}</a></td><td className="tabular-nums">{m(amt)}</td>{compare && <><td className="tabular-nums text-muted">{m(p.get(code) ?? money(0))}</td><td className="text-xs">{pct(amt, p.get(code) ?? money(0))}</td></>}</tr>;
  const total = (label: string, a: Decimal, b?: Decimal, strong?: boolean) => <tr className={cn("bg-surface-2", strong && "font-semibold")}><td>{label}</td><td className="tabular-nums">{m(a)}</td>{compare && <><td className="tabular-nums">{b ? m(b) : ""}</td><td className="text-xs">{b ? pct(a, b) : ""}</td></>}</tr>;
  const inc = cur.byAccount.filter((a) => a.type === "income"), cogs = cur.byAccount.filter((a) => a.code === "5400"), opx = cur.byAccount.filter((a) => a.type === "expense" && a.code !== "5400");
  return (
    <Card>
      <Table head={head}>
        <tr className="font-medium"><td colSpan={head.length}>Operating income</td></tr>{inc.map((a) => row(a.code, a.amount))}{total("Total operating income", cur.income, prev?.income)}
        <tr className="font-medium"><td colSpan={head.length}>Cost of goods sold</td></tr>{cogs.map((a) => row(a.code, a.amount))}{total("Gross profit", cur.grossProfit, prev?.grossProfit, true)}
        <tr className="font-medium"><td colSpan={head.length}>Operating expenses</td></tr>{opx.map((a) => row(a.code, a.amount))}{total("Total operating expenses", cur.expense.minus(cur.cogs), prev ? prev.expense.minus(prev.cogs) : undefined)}
        {total("Net profit / (loss)", cur.net, prev?.net, true)}
      </Table>
    </Card>
  );
}

async function Bs({ ctx, asOf }: { ctx: C; asOf: Date }) {
  const bs = await balanceSheet(ctx, { asOf });
  const sec = (label: string, rows: { code: string; name: string; amount: Decimal }[]) => <><tr className="font-medium"><td colSpan={2}>{label}</td></tr>{rows.map((a) => <tr key={a.code}><td className="ps-4">{a.code} {a.name}</td><td className="tabular-nums">{m(a.amount)}</td></tr>)}</>;
  return (
    <Card action={<Badge tone={bs.balanced ? "ok" : "danger"}>{bs.balanced ? "Balanced" : "Out of balance"}</Badge>}>
      <Table head={["Account", `As of ${fmtDate(asOf)}`]}>
        {sec("Assets", bs.assets)}<tr className="bg-surface-2 font-semibold"><td>Total assets</td><td className="tabular-nums">{m(bs.totalAssets)}</td></tr>
        {sec("Liabilities", bs.liabilities)}{sec("Equity", bs.equity)}
        <tr><td className="ps-4">Current year earnings</td><td className="tabular-nums">{m(bs.currentEarnings)}</td></tr>
        <tr className="bg-surface-2 font-semibold"><td>Total liabilities and equity</td><td className="tabular-nums">{m(bs.totalLiabilitiesAndEquity)}</td></tr>
      </Table>
    </Card>
  );
}

async function Cf({ ctx, f }: { ctx: C; f: R }) {
  const cf = await cashFlow(ctx, f);
  return (
    <Card action={<Badge tone={cf.reconciles ? "ok" : "danger"}>{cf.reconciles ? "Reconciles to cash" : "Does not reconcile"}</Badge>}>
      <Table head={["", "Amount"]}>
        <tr><td>Opening cash</td><td className="tabular-nums">{m(cf.opening)}</td></tr><tr><td>Net cash from operating activities</td><td className="tabular-nums">{m(cf.operating)}</td></tr>
        <tr><td>Net cash from investing activities</td><td className="tabular-nums">{m(cf.investing)}</td></tr><tr><td>Net cash from financing activities</td><td className="tabular-nums">{m(cf.financing)}</td></tr>
        <tr className="bg-surface-2"><td>Net change in cash</td><td className="tabular-nums">{m(cf.netChange)}</td></tr><tr className="font-semibold"><td>Closing cash</td><td className="tabular-nums">{m(cf.closing)}</td></tr>
      </Table>
      <p className="mt-2 text-xs text-muted">Direct method. Cash includes cash, bank, petty cash and card settlements in transit.</p>
    </Card>
  );
}

type TI = { customerId: string; issueDate: Date; status: string; lines: bk.Line[]; net: unknown; vat: unknown; total: unknown };
async function SalesBy({ ctx, f, by }: { ctx: C; f: R; by: "customer" | "item" }) {
  const inv = await tenantCol<TI>(ctx.orgId, "trade_invoices").find({ issueDate: { $gte: f.from, $lt: f.to }, status: { $nin: ["draft", "void"] } } as never, { limit: 10000 });
  const names = new Map((await bk.listCustomers(ctx)).map((c) => [c._id, c.name]));
  const g = new Map<string, { count: number; qty: number; net: Decimal; total: Decimal }>();
  const add = (k: string, qty: number, net: Decimal, total: Decimal) => { const x = g.get(k) ?? { count: 0, qty: 0, net: money(0), total: money(0) }; x.count++; x.qty += qty; x.net = x.net.plus(net); x.total = x.total.plus(total); g.set(k, x); };
  for (const i of inv) {
    if (by === "customer") add(names.get(i.customerId) ?? "?", 0, fromDecimal128(i.net as never), fromDecimal128(i.total as never));
    else for (const l of bk.totalsOf(i.lines).rows) add(l.description, l.qty, l.net, l.net.plus(l.vat));
  }
  const rows = [...g].sort((a, b) => b[1].net.comparedTo(a[1].net));
  const tot = rows.reduce((a, [, v]) => a.plus(v.net), money(0));
  return (
    <Card>
      <Table head={by === "customer" ? ["Customer", "Invoices", "Sales (excl. VAT)", "With VAT", "Share"] : ["Item / service", "Qty sold", "Sales (excl. VAT)", "With VAT", "Share"]} empty="No issued invoices in this period.">
        {rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{by === "customer" ? v.count : v.qty}</td><td className="tabular-nums">{m(v.net)}</td><td className="tabular-nums">{m(v.total)}</td><td className="text-xs">{tot.isZero() ? "" : `${v.net.div(tot).times(100).toFixed(1)}%`}</td></tr>)}
        {rows.length > 0 && <tr className="font-semibold"><td>Total</td><td /><td className="tabular-nums">{m(tot)}</td><td /><td /></tr>}
      </Table>
      <p className="mt-2 text-xs text-muted">Corporate (non-patient) invoices. Patient billing is reported under Billing.</p>
    </Card>
  );
}

async function ArAging({ ctx }: { ctx: C }) {
  const [t, p] = await Promise.all([bk.tradeAging(ctx), arAging(ctx, {})]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Corporate clients (by days past due)"><Table head={["Age", "Invoices", "Outstanding"]}>{t.buckets.map((b) => <tr key={b.label}><td>{b.label}</td><td>{b.count}</td><td className="tabular-nums">{m(b.amount)}</td></tr>)}<tr><td>Less unapplied payments and credits</td><td /><td className="tabular-nums">−{m(t.onAccount)}</td></tr><tr className="font-semibold"><td>Total</td><td /><td className="tabular-nums">{m(t.total)}</td></tr></Table></Card>
      <Card title="Patients (by days since invoice)"><Table head={["Age", "Invoices", "Outstanding"]}>{p.buckets.map((b) => <tr key={b.label}><td>{b.label}</td><td>{b.count}</td><td className="tabular-nums">{m(b.amount)}</td></tr>)}<tr className="font-semibold"><td>Total</td><td /><td className="tabular-nums">{m(p.total)}</td></tr></Table></Card>
    </div>
  );
}

async function CustBal({ ctx }: { ctx: C }) {
  const t = await bk.tradeAging(ctx);
  return <Card><Table head={["Customer", "Balance due"]} empty="No open balances.">{t.byCustomer.map((c) => <tr key={c.customerId}><td><a className="hover:underline" href={`/accounts/sales?tab=customers&customerId=${c.customerId}`}>{c.name}</a></td><td className="tabular-nums">{m(c.amount)}</td></tr>)}</Table></Card>;
}

async function ApAging({ ctx }: { ctx: C }) {
  const a = await apAging(ctx).catch(() => null);
  if (!a) return <Card><p className="text-sm text-muted">Your role cannot view supplier bills.</p></Card>;
  return <Card><Table head={["Age", "Bills", "Outstanding"]}>{a.buckets.map((b) => <tr key={b.label}><td>{b.label}</td><td>{b.count}</td><td className="tabular-nums">{m(b.amount)}</td></tr>)}<tr className="font-semibold"><td>Total</td><td /><td className="tabular-nums">{m(a.total)}</td></tr></Table></Card>;
}

async function VendBal({ ctx }: { ctx: C }) {
  const [bills, sup] = await Promise.all([listSupplierInvoices(ctx).catch(() => []), listSuppliers(ctx).catch(() => [])]);
  const g = new Map<string, Decimal>();
  for (const b of bills) if (["approved", "partially_paid"].includes(b.status)) g.set(b.supplierId, (g.get(b.supplierId) ?? money(0)).plus(fromDecimal128(b.balance)));
  const name = new Map(sup.map((s) => [s._id, s.name]));
  return <Card><Table head={["Vendor", "Balance payable"]} empty="No open bills.">{[...g].sort((a, b) => b[1].comparedTo(a[1])).map(([id, v]) => <tr key={id}><td>{name.get(id) ?? id}</td><td className="tabular-nums">{m(v)}</td></tr>)}</Table></Card>;
}

async function Expenses({ ctx, f }: { ctx: C; f: R }) {
  const [pl, accs, exps] = await Promise.all([pnl(ctx, f), coa.listAccounts(ctx), listExpenses(ctx, f)]);
  const name = new Map(accs.map((a) => [a.code, a.name]));
  const rows = pl.byAccount.filter((a) => a.type === "expense").sort((a, b) => b.amount.comparedTo(a.amount));
  const tot = rows.reduce((a, r) => a.plus(r.amount), money(0));
  return (
    <Card>
      <Table head={["Expense account", "Amount", "Share"]} empty="No expenses in this period.">
        {rows.map((r) => <tr key={r.code}><td><a className="hover:underline" href={`/accounts/reports?r=general-ledger&code=${r.code}`}>{r.code} {name.get(r.code)}</a></td><td className="tabular-nums">{m(r.amount)}</td><td className="w-48"><div className="flex items-center gap-2"><div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2"><div className="h-full brand-grad" style={{ width: `${tot.isZero() ? 0 : r.amount.div(tot).times(100).toNumber()}%` }} /></div><span className="text-xs">{tot.isZero() ? "" : `${r.amount.div(tot).times(100).toFixed(0)}%`}</span></div></td></tr>)}
        {rows.length > 0 && <tr className="font-semibold"><td>Total</td><td className="tabular-nums">{m(tot)}</td><td /></tr>}
      </Table>
      <p className="mt-2 text-xs text-muted">From the ledger, so it includes payroll, depreciation and stock costs as well as the {exps.length} expense(s) entered directly.</p>
    </Card>
  );
}

async function Tb({ ctx, f }: { ctx: C; f: R }) {
  const tb = await trialBalance(ctx, f);
  const ok = tb.totalDebit.equals(tb.totalCredit);
  return (
    <Card action={<Badge tone={ok ? "ok" : "danger"}>{ok ? "Balanced" : "Out of balance"}</Badge>}>
      <Table head={["Code", "Account", "Debit", "Credit", "Net"]} empty="No postings in this period.">
        {tb.rows.map((r) => <tr key={r.accountId}><td className="font-mono text-xs">{r.code}</td><td>{r.name}</td><td className="tabular-nums">{r.debit.toFixed(2)}</td><td className="tabular-nums">{r.credit.toFixed(2)}</td><td className="tabular-nums">{r.balance.toFixed(2)}</td></tr>)}
        <tr className="font-semibold"><td /><td>Total</td><td className="tabular-nums">{tb.totalDebit.toFixed(2)}</td><td className="tabular-nums">{tb.totalCredit.toFixed(2)}</td><td /></tr>
      </Table>
    </Card>
  );
}

async function Gl({ ctx, f, code, fromStr, toStr }: { ctx: C; f: R; code?: string; fromStr: string; toStr: string }) {
  const accounts = await coa.listAccounts(ctx);
  const sel = code ?? "1010";
  const gl = await coa.generalLedger(ctx, { code: sel, ...f }).catch(() => null);
  return (
    <Card title={<form className="flex flex-wrap items-center gap-2 print:hidden"><input type="hidden" name="r" value="general-ledger" /><input type="hidden" name="from" value={fromStr} /><input type="hidden" name="to" value={toStr} />
      <select name="code" defaultValue={sel} aria-label="Account" className="rounded-ui border border-border bg-surface px-3 py-1.5 text-sm">{accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select><button className="rounded-ui border border-border px-3 py-1.5 text-sm">Show</button></form>}>
      {gl ? <><Table head={["Date", "Entry", "Narration", "Debit", "Credit", "Balance"]} empty="No postings in this range.">
        <tr className="text-muted"><td colSpan={5}>Opening balance</td><td className="tabular-nums">{m(gl.opening)}</td></tr>
        {gl.rows.map((r, i) => <tr key={i}><td>{fmtDate(r.date)}</td><td className="font-mono text-xs">#{r.entryNo}</td><td>{r.memo}</td><td className="tabular-nums">{r.debit.isZero() ? "" : r.debit.toFixed(2)}</td><td className="tabular-nums">{r.credit.isZero() ? "" : r.credit.toFixed(2)}</td><td className="tabular-nums">{r.balance.toFixed(2)}</td></tr>)}
        <tr className="font-semibold"><td colSpan={5}>Closing balance (debit positive)</td><td className="tabular-nums">{m(gl.closing)}</td></tr>
      </Table>{gl.truncated && <p className="text-xs text-warn">Showing the first 5,000 postings. Narrow the dates.</p>}</> : <p className="text-sm text-muted">Account not found.</p>}
    </Card>
  );
}

async function Journal({ ctx, f }: { ctx: C; f: R }) {
  const [rows, accs] = await Promise.all([listJournals(ctx, 500), coa.listAccounts(ctx)]);
  const name = new Map(accs.map((a) => [a._id, `${a.code} ${a.name}`]));
  const inRange = rows.filter((r) => r.date >= f.from && r.date < f.to).slice(0, 150);
  return (
    <Card>
      <Table head={["Date", "#", "Account", "Debit", "Credit"]} empty="No journals in this period (the report shows the latest 500 entries).">
        {inRange.flatMap((r) => [
          <tr key={r._id} className="bg-surface-2"><td>{fmtDate(r.date)}</td><td className="font-mono text-xs">{r.entryNo}</td><td colSpan={3} className="text-xs">{r.memo}</td></tr>,
          ...r.lines.map((l, i) => <tr key={`${r._id}${i}`}><td /><td /><td className="ps-4">{name.get(l.accountId) ?? l.accountId}</td><td className="tabular-nums">{fromDecimal128(l.debit).isZero() ? "" : fromDecimal128(l.debit).toFixed(2)}</td><td className="tabular-nums">{fromDecimal128(l.credit).isZero() ? "" : fromDecimal128(l.credit).toFixed(2)}</td></tr>),
        ])}
      </Table>
    </Card>
  );
}

async function Vat({ ctx, f }: { ctx: C; f: R }) {
  const v = await vatSummary(ctx, f);
  return (
    <Card>
      <Table head={["", "Amount"]}>
        <tr><td>Output VAT (on sales)</td><td className="tabular-nums">{m(v.outputVat)}</td></tr><tr><td>Recoverable input VAT (on purchases)</td><td className="tabular-nums">{m(v.inputVat)}</td></tr>
        <tr className="font-semibold"><td>Net VAT payable</td><td className="tabular-nums">{m(v.netPayable)}</td></tr>
        {Object.entries(v.suppliesByClass).map(([k, x]) => <tr key={k}><td className="ps-4 text-muted">Supplies: {k}</td><td className="tabular-nums">{m(x as Decimal)}</td></tr>)}
      </Table>
      <p className="mt-2 text-xs text-warn">{v.note}</p>
    </Card>
  );
}
