import { requireCtx } from "@/lib/session";
import { parseRange, todayYmd } from "@/lib/range";
import { Alert, Badge, Card, NoAccess, Stat, Table, Tabs, aed } from "@/ui/kit";
import { BrandBanner } from "@/ui/brand";
import { ActionButton, ActionForm, fmtDate, type FieldDef } from "@/ui/forms";
import { fromDecimal128 } from "@/core/money";
import * as bk from "@/modules/books/service";
import * as coa from "@/modules/ledger/coa";
import { listPeriods } from "@/modules/ledger/periods";
import { apAging, listSuppliers, listSupplierInvoices } from "@/modules/procurement/service";

const TABS = [
  { key: "overview", label: "Overview" }, { key: "customers", label: "Corporate clients" }, { key: "estimates", label: "Package quotes" }, { key: "invoices", label: "Invoices" },
  { key: "receipts", label: "Receipts" }, { key: "credits", label: "Credit notes" }, { key: "recurring", label: "Wellness plans" }, { key: "vendor", label: "Supplier credits" },
  { key: "bank", label: "Banking" }, { key: "ledger", label: "Chart & ledger" },
];
const m = (d: { toFixed: (n: number) => string }) => aed(d.toFixed(2));
const d128 = (x: unknown) => m(fromDecimal128(x as never));
const LINES = "One service per row:  Service | qty | unit price | STD, ZERO or EXEMPT | income account (default 4500). Examples:  Pre-employment medicals | 40 | 180 | STD   then   Flu vaccination | 120 | 65 | ZERO";
const TONE: Record<string, "neutral" | "ok" | "warn" | "danger" | "info"> = { draft: "neutral", open: "info", partially_paid: "warn", paid: "ok", void: "danger", sent: "info", accepted: "ok", declined: "danger", converted: "neutral", delivered: "ok", active: "ok", paused: "warn", stopped: "neutral" };

type C = Awaited<ReturnType<typeof requireCtx>>;
type Cust = { value: string; label: string }[];

export default async function BooksPage({ searchParams }: { searchParams: Promise<{ tab?: string; error?: string; notice?: string; customerId?: string; code?: string; from?: string; to?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  if (!ctx.permissions.includes("ledger:view")) return <NoAccess what="the clinic books" />;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "overview";
  const back = `/books?tab=${tab}`;
  const can = ctx.permissions.includes("ledger:create" as never);
  const approve = ctx.permissions.includes("ledger:approve" as never);
  const custs: Cust = (await bk.listCustomers(ctx)).map((c) => ({ value: c._id, label: c.name }));
  const name = new Map(custs.map((c) => [c.value, c.label]));
  return (
    <div className="space-y-4">
      <BrandBanner eyebrow="Clinic books" title="Corporate health contracts, supplier credits, banking and the ledger">
        <p className="text-xs text-white/75">For billing that is not a single patient visit: employer medicals, school and hotel wellness plans, check-up package quotes and supplier credits for drugs and consumables. Every posting lands in the same ledger as the rest of the clinic.</p>
      </BrandBanner>
      {sp.error && <Alert>{sp.error}</Alert>}
      {sp.notice && <Alert tone="ok">{sp.notice}</Alert>}
      <Tabs tabs={TABS} active={tab} base="/books" />
      {tab === "overview" && <Overview ctx={ctx} />}
      {tab === "customers" && <Customers ctx={ctx} back={back} can={can} customerId={sp.customerId} />}
      {tab === "estimates" && <Docs ctx={ctx} back={back} can={can} custs={custs} name={name} kind="estimate" />}
      {tab === "invoices" && <Invoices ctx={ctx} back={back} can={can} approve={approve} custs={custs} name={name} />}
      {tab === "receipts" && <Receipts ctx={ctx} back={back} can={can} custs={custs} name={name} />}
      {tab === "credits" && <Credits ctx={ctx} back={back} can={can} custs={custs} name={name} />}
      {tab === "recurring" && <Recurring ctx={ctx} back={back} can={can} custs={custs} name={name} />}
      {tab === "vendor" && <Vendor ctx={ctx} back={back} can={can} />}
      {tab === "bank" && <Bank ctx={ctx} back={back} can={can} />}
      {tab === "ledger" && <Ledger ctx={ctx} back={back} can={can} approve={approve} sp={sp} />}
    </div>
  );
}

async function Overview({ ctx }: { ctx: C }) {
  const [s, ar, ap] = await Promise.all([bk.booksSummary(ctx), bk.tradeAging(ctx), apAging(ctx).catch(() => null)]);
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Cash and bank" value={m(s.cash)} /><Stat label="Receivables (all)" value={m(s.receivables)} hint="Patients, insurers, corporate clients" />
        <Stat label="Payables" value={m(s.payables)} /><Stat label="VAT payable" value={m(s.vatPayable)} hint="Output less input" />
        <Stat label="Income this year" value={m(s.income)} /><Stat label="Expenses this year" value={m(s.expense)} />
        <Stat label="Net profit this year" value={m(s.net)} tone={s.net.isNegative() ? "danger" : "ok"} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Corporate client balances by age">
          <Table head={["Age", "Invoices", "Outstanding"]}>
            {ar.buckets.map((b) => <tr key={b.label}><td>{b.label}</td><td>{b.count}</td><td className="tabular-nums">{m(b.amount)}</td></tr>)}
            <tr><td>On-account receipts and credits</td><td /><td className="tabular-nums">−{m(ar.onAccount)}</td></tr>
            <tr className="font-semibold"><td>Total (ties to account 1120)</td><td /><td className="tabular-nums">{m(ar.total)}</td></tr>
          </Table>
        </Card>
        <Card title="Supplier bills by age">
          {ap ? <Table head={["Age", "Bills", "Outstanding"]}>{ap.buckets.map((b) => <tr key={b.label}><td>{b.label}</td><td>{b.count}</td><td className="tabular-nums">{m(b.amount)}</td></tr>)}<tr className="font-semibold"><td>Total</td><td /><td className="tabular-nums">{m(ap.total)}</td></tr></Table> : <p className="text-sm text-muted">No access to procurement.</p>}
        </Card>
      </div>
      <Card title="Clients with open balances">
        <Table head={["Client", "Outstanding"]} empty={ar.byCustomer.length ? undefined : "No open corporate invoices."}>{ar.byCustomer.map((c) => <tr key={c.customerId}><td><a className="text-primary hover:underline" href={`/books?tab=customers&customerId=${c.customerId}`}>{c.name}</a></td><td className="tabular-nums">{m(c.amount)}</td></tr>)}</Table>
      </Card>
    </>
  );
}

async function Customers({ ctx, back, can, customerId }: { ctx: C; back: string; can: boolean; customerId?: string }) {
  const rows = await bk.listCustomers(ctx);
  const st = customerId ? await bk.customerStatement(ctx, customerId).catch(() => null) : null;
  return (
    <>
      <Card title={`Corporate clients (${rows.length})`}>
        <Table head={["Name", "TRN", "Terms", "Contact", ""]} empty={rows.length ? undefined : "No corporate clients yet. Add an employer, school or hotel you bill under a contract."}>
          {rows.map((c) => <tr key={c._id}><td>{c.name}</td><td className="font-mono text-xs">{c.trn ?? "—"}</td><td>{c.termsDays} days</td><td className="text-xs">{[c.email, c.phone].filter(Boolean).join(" · ") || "—"}</td><td><a className="text-xs text-primary hover:underline" href={`/books?tab=customers&customerId=${c._id}`}>Statement</a></td></tr>)}
        </Table>
        {can && <div className="mt-3 border-t border-border pt-3"><ActionForm action="bk.customer" back={back} submit="Add client" fields={[
          { name: "name", label: "Organisation name", required: true }, { name: "trn", label: "TRN (15 digits)" }, { name: "terms", label: "Payment terms (days)", type: "number", defaultValue: 30 }, { name: "email", label: "Email", type: "email" }, { name: "phone", label: "Phone" }]} /></div>}
      </Card>
      {st && (
        <Card title={`Statement: ${st.customer.name}`}>
          <Table head={["Date", "Reference", "Type", "Debit", "Credit", "Balance"]} empty="No activity.">
            {st.lines.map((l) => <tr key={l.ref}><td>{fmtDate(l.date)}</td><td className="font-mono text-xs">{l.ref}</td><td>{l.kind}</td><td className="tabular-nums">{l.debit.isZero() ? "" : m(l.debit)}</td><td className="tabular-nums">{l.credit.isZero() ? "" : m(l.credit)}</td><td className="tabular-nums">{m(l.balance)}</td></tr>)}
            <tr className="font-semibold"><td colSpan={5}>Balance due</td><td className="tabular-nums">{m(st.balance)}</td></tr>
          </Table>
        </Card>
      )}
    </>
  );
}

async function Docs({ ctx, back, can, custs, name, kind }: { ctx: C; back: string; can: boolean; custs: Cust; name: Map<string, string>; kind: bk.DocKind }) {
  const rows = await bk.listSalesDocs(ctx, kind);
  const label = "package quote";
  const next = ["invoice"];
  return (
    <Card title={`${label[0].toUpperCase()}${label.slice(1)}s (${rows.length})`}>
      <Table head={["No.", "Client", "Date", "Total", "Status", ""]} empty={rows.length ? undefined : "No package quotes yet. Quote a check-up or vaccination package before the client agrees."}>
        {rows.map((r) => <tr key={r._id}><td className="font-mono text-xs">{r.number}</td><td>{name.get(r.customerId)}</td><td>{fmtDate(r.date)}</td><td className="tabular-nums">{d128(r.total)}</td><td><Badge tone={TONE[r.status]}>{r.status}</Badge></td>
          <td className="space-x-1 whitespace-nowrap">{can && r.status !== "converted" && r.status !== "declined" && <>
            {["sent", "accepted", "declined"].filter((x) => x !== r.status).map((st) => <ActionButton key={st} action="bk.docStatus" back={back} hidden={{ id: r._id, status: st }} variant="ghost">Mark {st}</ActionButton>)}
            {next.map((t) => <ActionButton key={t} action="bk.docConvert" back={t === "invoice" ? "/books?tab=invoices" : back} hidden={{ id: r._id, to: t }}>→ {t.replace("_", " ")}</ActionButton>)}</>}
            {r.convertedTo && <span className="text-xs text-muted">→ {r.convertedTo.kind.replace("_", " ")}</span>}</td></tr>)}
      </Table>
      {can && <div className="mt-3 border-t border-border pt-3"><ActionForm action="bk.docCreate" back={back} hidden={{ kind }} submit={`Create ${label}`} fields={[
        { name: "customerId", label: "Client", type: "select", options: custs, required: true }, { name: "date", label: "Date", type: "date", defaultValue: todayYmd() }, { name: "notes", label: "Notes" },
        { name: "lines", label: "Services", type: "textarea", required: true, span: 3, hint: LINES }]} /></div>}
    </Card>
  );
}

async function Invoices({ ctx, back, can, approve, custs, name }: { ctx: C; back: string; can: boolean; approve: boolean; custs: Cust; name: Map<string, string> }) {
  const rows = await bk.listTradeInvoices(ctx);
  return (
    <Card title={`Corporate invoices (${rows.length})`}>
      <Table head={["No.", "Client", "Issued", "Due", "Total", "Balance", "Status", ""]} empty={rows.length ? undefined : "No invoices yet."}>
        {rows.map((r) => <tr key={r._id}><td className="font-mono text-xs">{r.number}</td><td>{name.get(r.customerId)}</td><td>{fmtDate(r.issueDate)}</td><td>{fmtDate(r.dueDate)}</td><td className="tabular-nums">{d128(r.total)}</td><td className="tabular-nums">{d128(r.balance)}</td><td><Badge tone={TONE[r.status]}>{r.status.replace("_", " ")}</Badge></td>
          <td className="space-x-1 whitespace-nowrap">{can && r.status === "draft" && <ActionButton action="bk.invIssue" back={back} hidden={{ id: r._id }} variant="primary">Issue</ActionButton>}
            {approve && (r.status === "draft" || r.status === "open") && <details className="inline-block align-top"><summary className="cursor-pointer text-xs text-danger">Void</summary><div className="mt-2"><ActionForm inline action="bk.invVoid" back={back} hidden={{ id: r._id }} submit="Confirm void" variant="danger" fields={[{ name: "reason", label: "Reason", required: true }]} /></div></details>}</td></tr>)}
      </Table>
      {can && <div className="mt-3 border-t border-border pt-3"><ActionForm action="bk.invCreate" back={back} submit="Create invoice" fields={[
        { name: "customerId", label: "Client", type: "select", options: custs, required: true }, { name: "date", label: "Invoice date", type: "date", defaultValue: todayYmd() }, { name: "due", label: "Due date (default: customer terms)", type: "date" },
        { name: "lines", label: "Lines", type: "textarea", required: true, span: 3, hint: LINES }, { name: "notes", label: "Notes" }, { name: "issue", label: "Issue now (post to ledger)", type: "checkbox", defaultValue: true }]} /></div>}
    </Card>
  );
}

async function Receipts({ ctx, back, can, custs, name }: { ctx: C; back: string; can: boolean; custs: Cust; name: Map<string, string> }) {
  const [rows, invs] = await Promise.all([bk.listReceipts(ctx), bk.listTradeInvoices(ctx)]);
  const open = invs.filter((i) => ["open", "partially_paid"].includes(i.status));
  return (
    <Card title="Receipts (payments from corporate clients)">
      <Table head={["No.", "Client", "Date", "Amount", "On account", "Method", ""]} empty={rows.length ? undefined : "No receipts yet."}>
        {rows.map((r) => <tr key={r._id}><td className="font-mono text-xs">{r.number}</td><td>{name.get(r.customerId)}</td><td>{fmtDate(r.date)}</td><td className="tabular-nums">{d128(r.amount)}</td><td className="tabular-nums">{d128(r.unapplied)}</td><td>{r.method}</td>
          <td>{can && !fromDecimal128(r.unapplied).isZero() && open.some((i) => i.customerId === r.customerId) && <ActionForm inline action="bk.applyCredit" back={back} hidden={{ source: "receipt", sourceId: r._id }} submit="Apply" variant="ghost" fields={[{ name: "invoiceId", label: "To invoice", type: "select", options: open.filter((i) => i.customerId === r.customerId).map((i) => ({ value: i._id, label: `${i.number} (${fromDecimal128(i.balance).toFixed(2)})` })) }]} />}</td></tr>)}
      </Table>
      {can && <div className="mt-3 border-t border-border pt-3"><ActionForm action="bk.receipt" back={back} submit="Record receipt" fields={[
        { name: "customerId", label: "Client", type: "select", options: custs, required: true },
        { name: "invoiceId", label: "Against invoice (blank = on account)", type: "select", options: [{ value: "", label: "On account" }, ...open.map((i) => ({ value: i._id, label: `${i.number} · ${name.get(i.customerId)} · ${fromDecimal128(i.balance).toFixed(2)}` }))] },
        { name: "amount", label: "Amount (AED)", required: true }, { name: "method", label: "Received into", type: "select", options: [{ value: "bank", label: "Bank" }, { value: "cash", label: "Cash" }, { value: "card_clearing", label: "Card" }] },
        { name: "date", label: "Date", type: "date", defaultValue: todayYmd() }, { name: "reference", label: "Cheque / transfer ref." }]} /></div>}
    </Card>
  );
}

async function Credits({ ctx, back, can, custs, name }: { ctx: C; back: string; can: boolean; custs: Cust; name: Map<string, string> }) {
  const [rows, invs] = await Promise.all([bk.listTradeCreditNotes(ctx), bk.listTradeInvoices(ctx)]);
  return (
    <Card title="Client credit notes">
      <Table head={["No.", "Client", "Date", "Total", "Unapplied", "Reason"]} empty={rows.length ? undefined : "No credit notes yet."}>
        {rows.map((r) => <tr key={r._id}><td className="font-mono text-xs">{r.number}</td><td>{name.get(r.customerId)}</td><td>{fmtDate(r.date)}</td><td className="tabular-nums">{d128(r.total)}</td><td className="tabular-nums">{d128(r.unapplied)}</td><td className="text-xs">{r.reason}</td></tr>)}
      </Table>
      {can && <div className="mt-3 border-t border-border pt-3"><ActionForm action="bk.creditNote" back={back} submit="Issue credit note" fields={[
        { name: "customerId", label: "Client", type: "select", options: custs, required: true },
        { name: "invoiceId", label: "Against invoice", type: "select", options: [{ value: "", label: "None (on account)" }, ...invs.filter((i) => !["draft", "void"].includes(i.status)).map((i) => ({ value: i._id, label: `${i.number} · ${name.get(i.customerId)}` }))] },
        { name: "reason", label: "Reason", required: true }, { name: "lines", label: "Lines credited", type: "textarea", required: true, span: 3, hint: LINES }]} /></div>}
    </Card>
  );
}

async function Recurring({ ctx, back, can, custs, name }: { ctx: C; back: string; can: boolean; custs: Cust; name: Map<string, string> }) {
  const rows = await bk.listRecurring(ctx);
  return (
    <Card title="Wellness plans and recurring invoices" action={can && <ActionButton action="bk.recRunDue" back={back} variant="primary">Generate all due now</ActionButton>}>
      <Table head={["Plan", "Client", "Every", "Next invoice", "Generated", "Status", ""]} empty={rows.length ? undefined : "No plans yet. Set up a monthly or quarterly staff wellness plan once and invoices are raised for you."}>
        {rows.map((r) => <tr key={r._id}><td>{r.name}</td><td>{name.get(r.customerId)}</td><td>{r.frequency}</td><td>{fmtDate(r.nextDate)}</td><td>{r.generated}</td><td><Badge tone={TONE[r.status]}>{r.status}</Badge></td>
          <td className="space-x-1 whitespace-nowrap">{can && r.status === "active" && <><ActionButton action="bk.recGenerate" back={back} hidden={{ id: r._id }}>Generate</ActionButton><ActionButton action="bk.recStatus" back={back} hidden={{ id: r._id, status: "paused" }} variant="ghost">Pause</ActionButton></>}
            {can && r.status !== "active" && <ActionButton action="bk.recStatus" back={back} hidden={{ id: r._id, status: "active" }} variant="ghost">Resume</ActionButton>}</td></tr>)}
      </Table>
      {can && <div className="mt-3 border-t border-border pt-3"><ActionForm action="bk.recCreate" back={back} submit="Create plan" fields={[
        { name: "name", label: "Plan name (e.g. Hotel staff wellness)", required: true }, { name: "customerId", label: "Client", type: "select", options: custs, required: true },
        { name: "frequency", label: "Repeat", type: "select", options: ["weekly", "monthly", "quarterly", "yearly"], defaultValue: "monthly" }, { name: "start", label: "First invoice date", type: "date", defaultValue: todayYmd() },
        { name: "lines", label: "Lines", type: "textarea", required: true, span: 3, hint: LINES }]} /></div>}
    </Card>
  );
}

async function Vendor({ ctx, back, can }: { ctx: C; back: string; can: boolean }) {
  const [rows, sup, sinv] = await Promise.all([bk.listVendorCredits(ctx), listSuppliers(ctx).catch(() => []), listSupplierInvoices(ctx).catch(() => [])]);
  const sname = new Map(sup.map((s) => [s._id, s.name]));
  return (
    <Card title="Supplier credits (credit notes for drugs, consumables and equipment)">
      <Table head={["No.", "Supplier", "Date", "Total", "Unapplied", "Reason"]} empty={rows.length ? undefined : "No supplier credits yet."}>
        {rows.map((r) => <tr key={r._id}><td className="font-mono text-xs">{r.number}</td><td>{sname.get(r.supplierId)}</td><td>{fmtDate(r.date)}</td><td className="tabular-nums">{d128(r.total)}</td><td className="tabular-nums">{d128(r.unapplied)}</td><td className="text-xs">{r.reason}</td></tr>)}
      </Table>
      {can && sup.length > 0 && <div className="mt-3 border-t border-border pt-3"><ActionForm action="bk.vendorCredit" back={back} submit="Record supplier credit" fields={[
        { name: "supplierId", label: "Supplier", type: "select", options: sup.map((s) => ({ value: s._id, label: s.name })), required: true },
        { name: "supplierInvoiceId", label: "Against bill (optional)", type: "select", options: [{ value: "", label: "None" }, ...sinv.filter((i) => ["approved", "partially_paid"].includes(i.status)).map((i) => ({ value: i._id, label: `${i.invoiceNo} · ${sname.get(i.supplierId)} · ${fromDecimal128(i.balance).toFixed(2)}` }))] },
        { name: "reason", label: "Reason", required: true }, { name: "lines", label: "Lines", type: "textarea", required: true, span: 3, hint: "Description | qty | unit price | STD, ZERO or EXEMPT | expense account (default 5800)" }]} /></div>}
    </Card>
  );
}

async function Bank({ ctx, back, can }: { ctx: C; back: string; can: boolean }) {
  const accts = (await coa.listAccounts(ctx)).filter((a) => ["1000", "1010", "1015", "1016"].includes(a.code));
  const all = await coa.listAccounts(ctx);
  const opts = (types: string[]) => all.filter((a) => a.active && types.includes(a.type) && !["1000", "1010", "1015", "1016"].includes(a.code)).map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }));
  const holders = [{ value: "bank", label: "Bank - Current" }, { value: "bank_savings", label: "Bank - Savings" }, { value: "cash", label: "Cash on hand" }, { value: "petty_cash", label: "Petty cash" }];
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{accts.map((a) => <Stat key={a.code} label={`${a.code} ${a.name}`} value={m(a.balance)} />)}</div>
      {can && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Money in (not from an invoice)"><ActionForm action="bk.bank" back={back} hidden={{ type: "deposit" }} submit="Record deposit" fields={[
            { name: "account", label: "Into", type: "select", options: holders }, { name: "other", label: "Credit account", type: "select", options: opts(["income", "liability", "equity"]) }, { name: "amount", label: "Amount", required: true }, { name: "date", label: "Date", type: "date", defaultValue: todayYmd() }, { name: "description", label: "Description", required: true }]} /></Card>
          <Card title="Money out (not for a bill)"><ActionForm action="bk.bank" back={back} hidden={{ type: "withdrawal" }} submit="Record withdrawal" fields={[
            { name: "account", label: "From", type: "select", options: holders }, { name: "other", label: "Debit account", type: "select", options: opts(["expense", "asset", "liability", "equity"]) }, { name: "amount", label: "Amount", required: true }, { name: "date", label: "Date", type: "date", defaultValue: todayYmd() }, { name: "description", label: "Description", required: true }]} /></Card>
          <Card title="Transfer between accounts"><ActionForm action="bk.bank" back={back} hidden={{ type: "transfer" }} submit="Transfer" fields={[
            { name: "other", label: "From", type: "select", options: holders }, { name: "account", label: "To", type: "select", options: holders, defaultValue: "cash" }, { name: "amount", label: "Amount", required: true }, { name: "date", label: "Date", type: "date", defaultValue: todayYmd() }, { name: "description", label: "Description", required: true }]} /></Card>
        </div>
      )}
      <p className="text-xs text-muted">Bank statement import and automatic matching are on the Finance page. Card settlements and cash-register closing are there too.</p>
    </>
  );
}

async function Ledger({ ctx, back, can, approve, sp }: { ctx: C; back: string; can: boolean; approve: boolean; sp: { code?: string; from?: string; to?: string } }) {
  const accounts = await coa.listAccounts(ctx);
  const { from, to, fromStr, toStr } = parseRange(sp);
  const gl = sp.code ? await coa.generalLedger(ctx, { code: sp.code, from, to }).catch(() => null) : null;
  const periods = await listPeriods(ctx);
  const open = periods.filter((p) => p.status === "open");
  const fields: FieldDef[] = [];
  void fields;
  return (
    <>
      <Card title="General ledger">
        <form className="flex flex-wrap items-end gap-2"><input type="hidden" name="tab" value="ledger" />
          <select name="code" defaultValue={sp.code} className="rounded-ui border border-border bg-surface px-3 py-2 text-sm">{accounts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select>
          <input name="from" type="date" defaultValue={fromStr} className="rounded-ui border border-border bg-surface px-3 py-2 text-sm" aria-label="From" /><input name="to" type="date" defaultValue={toStr} className="rounded-ui border border-border bg-surface px-3 py-2 text-sm" aria-label="To" />
          <button className="rounded-ui border border-border px-3 py-2 text-sm">Show</button></form>
        {gl && (
          <div className="mt-3"><Table head={["Date", "Entry", "Memo", "Debit", "Credit", "Balance"]} empty="No postings in this range.">
            <tr className="text-muted"><td colSpan={5}>Opening balance</td><td className="tabular-nums">{m(gl.opening)}</td></tr>
            {gl.rows.map((r, i) => <tr key={i}><td>{fmtDate(r.date)}</td><td className="font-mono text-xs">#{r.entryNo}</td><td>{r.memo}</td><td className="tabular-nums">{r.debit.isZero() ? "" : m(r.debit)}</td><td className="tabular-nums">{r.credit.isZero() ? "" : m(r.credit)}</td><td className="tabular-nums">{m(r.balance)}</td></tr>)}
            <tr className="font-semibold"><td colSpan={5}>Closing balance (debit positive)</td><td className="tabular-nums">{m(gl.closing)}</td></tr>
          </Table>{gl.truncated && <p className="text-xs text-warn">Showing the first 5,000 postings. Narrow the dates.</p>}</div>
        )}
      </Card>
      <Card title="Chart of accounts">
        <Table head={["Code", "Name", "Type", "Balance", "Status", ""]}>
          {accounts.map((a) => <tr key={a.code}><td className="font-mono text-xs">{a.code}</td><td>{a.name}{a.system && <span className="ms-1 text-[10px] text-muted">system</span>}</td><td className="capitalize">{a.type}</td><td className="tabular-nums">{m(a.balance)}</td><td><Badge tone={a.active ? "ok" : "neutral"}>{a.active ? "active" : "inactive"}</Badge></td>
            <td>{approve && !a.system && <ActionButton action="coa.active" back={back} hidden={{ code: a.code, active: a.active ? "0" : "1" }} variant="ghost">{a.active ? "Deactivate" : "Activate"}</ActionButton>}</td></tr>)}
        </Table>
        {approve && <div className="mt-3 border-t border-border pt-3"><ActionForm action="coa.add" back={back} submit="Add account" fields={[{ name: "code", label: "Code (4 digits)", required: true }, { name: "name", label: "Name", required: true }, { name: "type", label: "Type", type: "select", options: ["asset", "liability", "equity", "income", "expense"] }]} /></div>}
      </Card>
      {can && (
        <Card title="Manual journal">
          <ActionForm action="journal.manual" back={back} submit="Post journal" fields={[
            { name: "date", label: "Date", type: "date", defaultValue: todayYmd() }, { name: "memo", label: "Memo", required: true, span: 2 },
            { name: "lines", label: "Lines", type: "textarea", required: true, span: 3, hint: "One line per row: account code | debit | credit. Example:  5200 | 1500 |   then   1010 | | 1500. Debits must equal credits. Posted entries cannot be edited, only reversed (Accounting → Journal)." }]} />
        </Card>
      )}
      {approve && (
        <Card title="Transaction lock date">
          <p className="mb-2 text-sm text-muted">Locks every period up to and including the month you pick. Nobody can post into a locked period. {open.length} period(s) are open.</p>
          <ActionForm action="bk.lockThrough" back={back} inline submit="Lock through" variant="danger" fields={[{ name: "year", label: "Year", type: "number", required: true, defaultValue: new Date().getFullYear() }, { name: "month", label: "Month (1-12)", type: "number", required: true }]} />
        </Card>
      )}
    </>
  );
}
