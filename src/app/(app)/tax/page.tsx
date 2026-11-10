import { requireCtx } from "@/lib/session";
import { Alert, Badge, Card, NoAccess, Stat, Table, Tabs, aed } from "@/ui/kit";
import { BrandBanner } from "@/ui/brand";
import { ActionButton, ActionForm, fmtDate } from "@/ui/forms";
import { CT, computeCorporateTax, ctCalendar, getTaxConfig, listTaxAdjustments } from "@/modules/tax/corporateTax";
import { CATEGORIES, assetRegisterSummary, listAssets } from "@/modules/assets/service";
import { listExpenses } from "@/modules/finance/expenses";
import { fromDecimal128 } from "@/core/money";
import { tenantCol } from "@/core/db";
import { dubaiParts } from "@/core/time";

const TABS = [{ key: "ct", label: "Corporate tax" }, { key: "assets", label: "Fixed assets" }, { key: "expenses", label: "Expenses" }];
const m = (d: { toFixed: (n: number) => string }) => aed(d.toFixed(2));

export default async function TaxPage({ searchParams }: { searchParams: Promise<{ tab?: string; error?: string; year?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  if (!ctx.permissions.includes("ledger:view")) return <NoAccess what="tax and fixed assets" />;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "ct";
  const thisYear = Number(dubaiParts(new Date()).ymd.slice(0, 4));
  const year = Number(sp.year) >= 2023 && Number(sp.year) <= thisYear + 1 ? Number(sp.year) : thisYear;
  const can = (p: string) => ctx.permissions.includes(p as never);
  const back = `/tax?tab=${tab}&year=${year}`;
  return (
    <div className="space-y-4">
      <BrandBanner eyebrow="Tax & assets" title="Corporate tax, fixed assets and expenses">
        <p className="text-xs text-white/70">UAE corporate tax: 0% up to AED 375,000, 9% above. Computed from the ledger; filing itself is done on the FTA EmaraTax portal.</p>
      </BrandBanner>
      {sp.error && <Alert>{sp.error}</Alert>}
      <Tabs tabs={TABS} active={tab} base="/tax" />
      {tab === "ct" && <CorporateTax ctx={ctx} back={back} can={can} year={year} thisYear={thisYear} />}
      {tab === "assets" && <Assets ctx={ctx} back={back} can={can} />}
      {tab === "expenses" && <Expenses ctx={ctx} back={back} can={can} />}
    </div>
  );
}
type C = Awaited<ReturnType<typeof requireCtx>>;
type Can = (p: string) => boolean;

async function CorporateTax({ ctx, back, can, year, thisYear }: { ctx: C; back: string; can: Can; year: number; thisYear: number }) {
  const cfg = await getTaxConfig(ctx);
  const first = cfg.firstYear ?? year;
  const years = Array.from({ length: Math.max(1, thisYear - first + 1) }, (_, i) => first + i);
  if (year < first) return <Alert tone="warn">Corporate tax starts with {first} for this entity.</Alert>;
  const c = await computeCorporateTax(ctx, year);
  const adj = await listTaxAdjustments(ctx, year);
  const filed = c.status === "filed";
  const inProgress = year >= thisYear;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Tax period</span>
        {years.map((y) => <a key={y} href={`/tax?tab=ct&year=${y}`} className={`rounded-lg px-3 py-1 ${y === year ? "brand-grad font-semibold text-white" : "bg-surface-2 text-muted hover:text-fg"}`}>FY{y}</a>)}
        <span className="text-xs text-muted">1 Jan – 31 Dec</span>
        {filed ? <Badge tone="ok">Filed {c.reference}</Badge> : inProgress ? <Badge tone="info">In progress</Badge> : <Badge tone="warn">Due {fmtDate(c.dueDate)}</Badge>}
      </div>
      {!cfg.registered && <Alert tone="warn">Not marked as registered for corporate tax. Register on EmaraTax and enter the TRN below; late registration carries a penalty.</Alert>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Accounting profit" value={m(c.accountingProfit)} hint={`Revenue ${m(c.revenue)}`} tone={c.accountingProfit.isNegative() ? "danger" : undefined} />
        <Stat label="Taxable income" value={m(c.taxableIncome)} hint={`Before losses ${m(c.taxableBeforeLoss)}`} />
        <Stat label="Corporate tax (9%)" value={m(c.tax)} hint={c.tax.isZero() ? "Within the 0% band or loss" : `Effective ${c.effectiveRate.toFixed(2)}% of profit`} tone={c.tax.isZero() ? "ok" : "warn"} />
        <Stat label="Tax losses carried forward" value={m(c.lossCarriedForward)} hint={`Used this year ${m(c.lossUsed)}`} />
      </div>
      <Card title={`Computation FY${year}`}>
        <Table head={["Step", "Source", "AED"]}>
          <tr><td>Accounting profit before corporate tax (ledger)</td><td><Badge>ledger</Badge></td><td className="tabular-nums">{m(c.accountingProfit)}</td></tr>
          {c.addBacks.map((l) => <tr key={l.label}><td>+ {l.label}</td><td><Badge tone="warn">{l.source}</Badge></td><td className="tabular-nums">{m(l.amount)}</td></tr>)}
          {c.deductions.map((l) => <tr key={l.label}><td>− {l.label}</td><td><Badge tone="info">{l.source}</Badge></td><td className="tabular-nums">−{m(l.amount)}</td></tr>)}
          <tr className="font-semibold"><td>Taxable income before loss relief</td><td /><td className="tabular-nums">{m(c.taxableBeforeLoss)}</td></tr>
          <tr><td>− Tax losses used (max 75% of taxable income; pool brought forward {m(c.lossBroughtForward)})</td><td /><td className="tabular-nums">−{m(c.lossUsed)}</td></tr>
          <tr className="font-semibold"><td>Taxable income</td><td /><td className="tabular-nums">{m(c.taxableIncome)}</td></tr>
          <tr><td>Tax: 0% on first {aed(CT.zeroBand)}, {CT.rate}% above</td><td /><td className="tabular-nums font-semibold">{m(c.tax)}</td></tr>
        </Table>
        {c.notes.length > 0 && <ul className="mt-3 list-disc space-y-1 ps-5 text-xs text-muted">{c.notes.map((x) => <li key={x}>{x}</li>)}</ul>}
        <p className="mt-3 text-xs text-muted">Small Business Relief: {c.sbrEligible ? "eligible (revenue within AED 3m)" : "not eligible"}{c.sbrApplied ? " and applied" : cfg.sbrElected ? "" : ", not elected"}. Qualifying Free Zone status, group relief, transfer pricing and the interest-limitation rule are not modelled; confirm with a tax adviser before filing.</p>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Provision, payment and filing">
          <dl className="grid grid-cols-2 gap-y-2 text-sm"><dt className="text-muted">Provision booked</dt><dd className="text-end tabular-nums">{m(c.provisionBooked)}</dd><dt className="text-muted">Paid to FTA</dt><dd className="text-end tabular-nums">{m(c.paid)}</dd><dt className="text-muted">Payable now</dt><dd className="text-end font-semibold tabular-nums">{m(c.payable)}</dd><dt className="text-muted">Return and payment due</dt><dd className="text-end">{fmtDate(c.dueDate)}</dd></dl>
          {!filed && (
            <div className="mt-4 space-y-3">
              {can("ledger:create") && <ActionButton action="tax.provision" back={back} hidden={{ year }} variant="primary">Book / update provision ({m(c.tax.minus(c.provisionBooked))})</ActionButton>}
              {can("ledger:create") && c.payable.gt(0) && <ActionForm inline action="tax.pay" back={back} hidden={{ year }} submit="Record payment" fields={[{ name: "amount", label: "Amount (AED)", required: true, defaultValue: c.payable.toFixed(2) }, { name: "method", label: "From", type: "select", options: [{ value: "bank", label: "Bank" }, { value: "cash", label: "Cash" }] }]} />}
              {can("ledger:approve") && <ActionForm inline action="tax.file" back={back} hidden={{ year }} submit="Mark return filed" variant="outline" fields={[{ name: "reference", label: "FTA submission reference", required: true }]} />}
            </div>
          )}
        </Card>
        <Card title="Registration and relief settings">
          {can("ledger:approve") ? <ActionForm action="tax.config" back={back} submit="Save" fields={[
            { name: "trn", label: "Corporate tax TRN (15 digits)", defaultValue: cfg.trn ?? "" }, { name: "firstYear", label: "First tax period (year)", type: "number", defaultValue: cfg.firstYear ?? year },
            { name: "losses", label: "Tax losses brought forward (AED)", defaultValue: cfg.lossesBroughtForward },
            { name: "registered", label: "Registered for corporate tax", type: "checkbox", defaultValue: cfg.registered }, { name: "sbr", label: "Elect Small Business Relief (gives up loss carry-forward)", type: "checkbox", defaultValue: cfg.sbrElected },
          ]} /> : <p className="text-sm text-muted">TRN {cfg.trn ?? "not set"}. Changing these settings needs finance approval rights.</p>}
        </Card>
      </div>
      <Card title="Tax adjustments">
        <Table head={["Type", "Description", "AED", ""]} empty={adj.length ? undefined : "No manual adjustments for this period."}>
          {adj.map((a) => <tr key={a._id}><td><Badge tone={a.kind === "add_back" ? "warn" : "info"}>{a.kind === "add_back" ? "Add back" : "Deduct"}</Badge></td><td>{a.label}{a.note && <div className="text-xs text-muted">{a.note}</div>}</td><td className="tabular-nums">{m(fromDecimal128(a.amount))}</td><td>{!filed && can("ledger:approve") && <ActionButton action="tax.adjustRemove" back={back} hidden={{ id: a._id }} variant="ghost">Remove</ActionButton>}</td></tr>)}
        </Table>
        {!filed && can("ledger:create") && <div className="mt-4"><ActionForm action="tax.adjust" back={back} hidden={{ year }} submit="Add adjustment" fields={[
          { name: "kind", label: "Type", type: "select", options: [{ value: "add_back", label: "Add back (non-deductible)" }, { value: "deduct", label: "Deduct (exempt income etc.)" }] }, { name: "label", label: "Description", required: true, placeholder: "e.g. Administrative penalties" }, { name: "amount", label: "Amount (AED)", required: true }, { name: "note", label: "Note", span: 3 },
        ]} /></div>}
        <p className="mt-3 text-xs text-muted">Entertainment (50%) and non-deductible items recorded under Expenses are added back automatically. Typical clinic items: client entertainment, fines and penalties, owner personal costs, non-qualifying donations.</p>
      </Card>
      <Card title="Calendar"><ul className="space-y-1.5 text-sm">{ctCalendar(year).map((x) => <li key={x.label} className="flex justify-between gap-3"><span>{x.label}</span><span className="text-muted">{x.due}</span></li>)}</ul></Card>
    </>
  );
}

async function Assets({ ctx, back, can }: { ctx: C; back: string; can: Can }) {
  const [rows, sum] = await Promise.all([listAssets(ctx), assetRegisterSummary(ctx)]);
  const nowYm = dubaiParts(new Date()).ymd.slice(0, 7);
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Cost" value={m(sum.cost)} hint={`${rows.filter((r) => r.status === "active").length} active assets`} />
        <Stat label="Accumulated depreciation" value={m(sum.accumulated)} />
        <Stat label="Net book value" value={m(sum.nbv)} tone="ok" />
        <Stat label="Register vs ledger" value={sum.reconciled ? "Agrees" : "Differs"} tone={sum.reconciled ? "ok" : "danger"} hint={sum.reconciled ? "Cost and depreciation tie to 1500 / 1510" : `Cost ${m(sum.costDifference)}, depreciation ${m(sum.accumulatedDifference)}`} />
      </div>
      <Card title="Fixed-asset register" action={can("ledger:create") && <ActionForm inline action="asset.depreciate" back={back} submit="Post depreciation" variant="outline" fields={[{ name: "period", label: "Month", type: "text", defaultValue: nowYm, placeholder: "YYYY-MM" }]} />}>
        <Table head={["Tag", "Asset", "Category", "Cost", "Accum.", "NBV", "Life", "Status", ""]} empty={rows.length ? undefined : "No assets registered."}>
          {rows.map((a) => { const cost = fromDecimal128(a.cost), acc = fromDecimal128(a.accumulated); return (
            <tr key={a._id}><td className="font-mono text-xs">{a.tag}</td><td>{a.name}<div className="text-xs text-muted">{fmtDate(a.purchaseDate)}{a.depreciatedThrough ? ` · depreciated to ${a.depreciatedThrough}` : ""}</div></td><td>{a.category}</td><td className="tabular-nums">{m(cost)}</td><td className="tabular-nums">{m(acc)}</td><td className="tabular-nums">{m(cost.minus(acc))}</td><td>{a.lifeMonths / 12} yr</td>
              <td>{a.status === "disposed" ? <Badge>Disposed</Badge> : <Badge tone="ok">Active</Badge>}</td>
              <td>{a.status === "active" && can("ledger:approve") && <ActionForm inline action="asset.dispose" back={back} hidden={{ id: a._id }} submit="Dispose" variant="ghost" fields={[{ name: "proceeds", label: "Proceeds", defaultValue: "0.00" }]} />}</td></tr>); })}
        </Table>
        <p className="mt-3 text-xs text-muted">Straight-line monthly depreciation. Corporate tax follows accounting depreciation, so this register is also the tax schedule. Running a month twice posts nothing new.</p>
      </Card>
      {can("ledger:create") && <Card title="Register a new asset"><ActionForm action="asset.add" back={back} submit="Register and post purchase" fields={[
        { name: "name", label: "Asset", required: true, placeholder: "e.g. Intra-oral scanner" }, { name: "category", label: "Category", type: "select", options: [...CATEGORIES] }, { name: "date", label: "Purchase date", type: "date", required: true },
        { name: "cost", label: "Cost excl. VAT (AED)", required: true }, { name: "vat", label: "Input VAT (AED)", defaultValue: "0.00" }, { name: "residual", label: "Residual value (AED)", defaultValue: "0.00" },
        { name: "life", label: "Useful life (months)", type: "number", required: true, defaultValue: 60 }, { name: "paidFrom", label: "Paid from", type: "select", options: [{ value: "bank", label: "Bank" }, { value: "cash", label: "Cash" }, { value: "ap", label: "Payable (supplier)" }] }, { name: "vendor", label: "Supplier" },
        { name: "location", label: "Location" }, { name: "serial", label: "Serial no." },
      ]} /></Card>}
    </>
  );
}

async function Expenses({ ctx, back, can }: { ctx: C; back: string; can: Can }) {
  const rows = await listExpenses(ctx);
  const accs = (await tenantCol<{ code: string; name: string; type: string; active: boolean }>(ctx.orgId, "accounts").find({ type: "expense", active: true } as never, { sort: { code: 1 } })).filter((a) => !["5000", "5400", "5900", "5950", "5960", "5910", "5330", "5320", "5310"].includes(a.code));
  return (
    <>
      <Card title="Operating expenses">
        <Table head={["Date", "Vendor", "Description", "Account", "Total", "Tax treatment"]} empty={rows.length ? undefined : "No direct expenses recorded yet. Rent, utilities and payroll are posted through their own modules and journals."}>
          {rows.map((e) => <tr key={e._id}><td>{fmtDate(e.date)}</td><td>{e.vendor}</td><td>{e.description}</td><td>{e.categoryName}</td><td className="tabular-nums">{m(fromDecimal128(e.total))}</td><td><Badge tone={e.treatment === "deductible" ? "ok" : "warn"}>{e.treatment === "deductible" ? "Deductible" : e.treatment === "entertainment_50" ? "50% entertainment" : "Non-deductible"}</Badge></td></tr>)}
        </Table>
      </Card>
      {can("ledger:create") && <Card title="Record an expense"><ActionForm action="exp.add" back={back} submit="Post expense" fields={[
        { name: "vendor", label: "Vendor", required: true }, { name: "description", label: "Description", required: true }, { name: "reference", label: "Tax invoice no." },
        { name: "category", label: "Expense account", type: "select", options: accs.map((a) => ({ value: a.code, label: `${a.code} ${a.name}` })) }, { name: "net", label: "Amount excl. VAT (AED)", required: true },
        { name: "vat", label: "VAT", type: "select", options: [{ value: "STD", label: "5% standard" }, { value: "ZERO", label: "Zero-rated" }, { value: "EXEMPT", label: "Exempt / no VAT" }] },
        { name: "paidFrom", label: "Paid from", type: "select", options: [{ value: "bank", label: "Bank" }, { value: "cash", label: "Cash" }, { value: "petty_cash", label: "Petty cash" }, { value: "card_clearing", label: "Company card" }] },
        { name: "treatment", label: "Corporate tax treatment", type: "select", options: [{ value: "deductible", label: "Fully deductible" }, { value: "entertainment_50", label: "Client entertainment (50% deductible, VAT not recoverable)" }, { value: "non_deductible", label: "Not deductible (fines, personal)" }] }, { name: "date", label: "Date", type: "date" },
      ]} /></Card>}
    </>
  );
}
