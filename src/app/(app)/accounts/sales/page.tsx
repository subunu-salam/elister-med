import { requireCtx } from "@/lib/session";
import { todayYmd } from "@/lib/range";
import { Alert, Badge, Card, Table, Tabs } from "@/ui/kit";
import { ActionButton, ActionForm, fmtDate } from "@/ui/forms";
import { fromDecimal128 } from "@/core/money";
import * as bk from "@/modules/books/service";
import { listItems } from "@/modules/accounts/items";
import { LINES_HINT, TONE, d128, m } from "../_shared";

const TABS = [
  { key: "customers", label: "Customers" }, { key: "quotes", label: "Quotes" }, { key: "orders", label: "Sales orders" }, { key: "invoices", label: "Invoices" },
  { key: "payments", label: "Payments received" }, { key: "credits", label: "Credit notes" }, { key: "recurring", label: "Recurring invoices" },
];
type C = Awaited<ReturnType<typeof requireCtx>>;
type Opt = { value: string; label: string }[];
type P = { ctx: C; back: string; can: boolean; custs: Opt; name: Map<string, string>; skus: string };

export default async function SalesPage({ searchParams }: { searchParams: Promise<{ tab?: string; error?: string; notice?: string; customerId?: string; status?: string; invoice?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "invoices";
  const back = `/accounts/sales?tab=${tab}`;
  const can = ctx.permissions.includes("ledger:create" as never);
  const [cl, its] = await Promise.all([bk.listCustomers(ctx), listItems(ctx, { activeOnly: true })]);
  const custs: Opt = cl.map((c) => ({ value: c._id, label: c.name }));
  const name = new Map(custs.map((c) => [c.value, c.label]));
  const skus = its.length ? `Items: ${its.slice(0, 12).map((i) => `@${i.sku} (${i.name})`).join(", ")}${its.length > 12 ? "…" : ""}` : "No items yet. Add them under Items to pick them with @SKU.";
  const p: P = { ctx, back, can, custs, name, skus };
  return (
    <div className="space-y-4">
      {sp.error && <Alert>{sp.error}</Alert>}
      {sp.notice && <Alert tone="ok">{sp.notice}</Alert>}
      <Tabs tabs={TABS} active={tab} base="/accounts/sales" />
      {tab === "customers" && <Customers {...p} customerId={sp.customerId} />}
      {tab === "quotes" && <Docs {...p} kind="estimate" />}
      {tab === "orders" && <Docs {...p} kind="sales_order" />}
      {tab === "invoices" && <Invoices {...p} approve={ctx.permissions.includes("ledger:approve" as never)} status={sp.status} />}
      {tab === "payments" && <Payments {...p} invoice={sp.invoice} />}
      {tab === "credits" && <Credits {...p} />}
      {tab === "recurring" && <Recurring {...p} />}
    </div>
  );
}

async function Customers({ ctx, back, can, customerId }: P & { customerId?: string }) {
  const [rows, aging] = await Promise.all([bk.listCustomers(ctx), bk.tradeAging(ctx)]);
  const due = new Map(aging.byCustomer.map((c) => [c.customerId, c.amount]));
  const st = customerId ? await bk.customerStatement(ctx, customerId).catch(() => null) : null;
  return (
    <>
      <Card title={`Customers (${rows.length})`}>
        <Table head={["Name", "TRN", "Terms", "Contact", "Receivable", ""]} empty={rows.length ? undefined : "No customers yet. Add an employer, school, hotel or other organisation you invoice."}>
          {rows.map((c) => <tr key={c._id}><td className="font-medium">{c.name}</td><td className="font-mono text-xs">{c.trn ?? "—"}</td><td>Net {c.termsDays}</td><td className="text-xs">{[c.email, c.phone].filter(Boolean).join(" · ") || "—"}</td>
            <td className="tabular-nums">{due.get(c._id) ? m(due.get(c._id)!) : "—"}</td><td><a className="text-xs text-primary hover:underline" href={`/accounts/sales?tab=customers&customerId=${c._id}`}>Statement</a></td></tr>)}
        </Table>
        {can && <div id="new" className="mt-3 border-t border-border pt-3"><ActionForm action="bk.customer" back={back} submit="Add customer" fields={[
          { name: "name", label: "Organisation name", required: true }, { name: "trn", label: "TRN (15 digits)" }, { name: "terms", label: "Payment terms (days)", type: "number", defaultValue: 30 }, { name: "email", label: "Email", type: "email" }, { name: "phone", label: "Phone" }]} /></div>}
      </Card>
      {st && (
        <Card title={`Statement of account: ${st.customer.name}`}>
          <Table head={["Date", "Reference", "Type", "Debit", "Credit", "Balance"]} empty="No activity.">
            {st.lines.map((l) => <tr key={l.ref}><td>{fmtDate(l.date)}</td><td className="font-mono text-xs">{l.ref}</td><td>{l.kind}</td><td className="tabular-nums">{l.debit.isZero() ? "" : m(l.debit)}</td><td className="tabular-nums">{l.credit.isZero() ? "" : m(l.credit)}</td><td className="tabular-nums">{m(l.balance)}</td></tr>)}
            <tr className="font-semibold"><td colSpan={5}>Balance due</td><td className="tabular-nums">{m(st.balance)}</td></tr>
          </Table>
        </Card>
      )}
    </>
  );
}

async function Docs({ ctx, back, can, custs, name, skus, kind }: P & { kind: "estimate" | "sales_order" }) {
  const rows = await bk.listSalesDocs(ctx, kind);
  const label = kind === "estimate" ? "Quote" : "Sales order";
  const next = kind === "estimate" ? ["sales_order", "invoice"] : ["invoice"];
  return (
    <Card title={`${label}s (${rows.length})`}>
      <Table head={["No.", "Customer", "Date", "Total", "Status", ""]} empty={rows.length ? undefined : `No ${label.toLowerCase()}s yet.`}>
        {rows.map((r) => <tr key={r._id}><td className="font-mono text-xs">{r.number}</td><td>{name.get(r.customerId)}</td><td>{fmtDate(r.date)}</td><td className="tabular-nums">{d128(r.total)}</td><td><Badge tone={TONE[r.status]}>{r.status}</Badge></td>
          <td className="space-x-1 whitespace-nowrap">{can && r.status !== "converted" && r.status !== "declined" && <>
            {(kind === "estimate" ? ["sent", "accepted", "declined"] : []).filter((x) => x !== r.status).map((st) => <ActionButton key={st} action="bk.docStatus" back={back} hidden={{ id: r._id, status: st }} variant="ghost">Mark {st}</ActionButton>)}
            {next.map((t) => <ActionButton key={t} action="bk.docConvert" back={t === "invoice" ? "/accounts/sales?tab=invoices" : "/accounts/sales?tab=orders"} hidden={{ id: r._id, to: t }}>→ {t.replace("_", " ")}</ActionButton>)}</>}
            {r.convertedTo && <span className="text-xs text-muted">→ {r.convertedTo.kind.replace("_", " ")}</span>}</td></tr>)}
      </Table>
      {can && <div id="new" className="mt-3 border-t border-border pt-3"><ActionForm action="acc.docCreate" back={back} hidden={{ kind }} submit={`Create ${label.toLowerCase()}`} fields={[
        { name: "customerId", label: "Customer", type: "select", options: custs, required: true }, { name: "date", label: "Date", type: "date", defaultValue: todayYmd() }, { name: "notes", label: "Notes" },
        { name: "lines", label: "Lines", type: "textarea", required: true, span: 3, hint: `${LINES_HINT} ${skus}` }]} /></div>}
    </Card>
  );
}

async function Invoices({ ctx, back, can, approve, custs, name, skus, status }: P & { approve: boolean; status?: string }) {
  const all = await bk.listTradeInvoices(ctx);
  const now = Date.now();
  const overdue = (r: (typeof all)[number]) => ["open", "partially_paid"].includes(r.status) && r.dueDate.getTime() < now;
  const rows = status === "overdue" ? all.filter(overdue) : status ? all.filter((r) => r.status === status) : all;
  const filters = [["", "All"], ["draft", "Draft"], ["open", "Unpaid"], ["partially_paid", "Partially paid"], ["overdue", "Overdue"], ["paid", "Paid"], ["void", "Void"]];
  const outstanding = all.filter((r) => ["open", "partially_paid"].includes(r.status)).reduce((a, r) => a.plus(fromDecimal128(r.balance)), fromDecimal128("0"));
  return (
    <Card title={`Invoices (${rows.length})`} action={<span className="text-xs text-muted">Outstanding {m(outstanding)} · {all.filter(overdue).length} overdue</span>}>
      <div className="mb-3 flex flex-wrap gap-1.5">{filters.map(([k, l]) => <a key={k} href={`/accounts/sales?tab=invoices${k ? `&status=${k}` : ""}`} className={`rounded-full border px-3 py-1 text-xs ${(status ?? "") === k ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-surface-2"}`}>{l}</a>)}</div>
      <Table head={["No.", "Customer", "Issued", "Due", "Total", "Balance", "Status", ""]} empty={rows.length ? undefined : "No invoices here."}>
        {rows.map((r) => <tr key={r._id}><td className="font-mono text-xs">{r.number}</td><td>{name.get(r.customerId)}</td><td>{fmtDate(r.issueDate)}</td><td className={overdue(r) ? "text-danger" : ""}>{fmtDate(r.dueDate)}</td><td className="tabular-nums">{d128(r.total)}</td><td className="tabular-nums">{d128(r.balance)}</td>
          <td><Badge tone={overdue(r) ? "danger" : TONE[r.status]}>{overdue(r) ? "overdue" : r.status.replace("_", " ")}</Badge></td>
          <td className="space-x-1 whitespace-nowrap">{can && r.status === "draft" && <ActionButton action="bk.invIssue" back={back} hidden={{ id: r._id }} variant="primary">Issue</ActionButton>}
            {can && ["open", "partially_paid"].includes(r.status) && <a className="text-xs text-primary hover:underline" href={`/accounts/sales?tab=payments&invoice=${r._id}#new`}>Record payment</a>}
            {approve && (r.status === "draft" || r.status === "open") && <details className="inline-block align-top"><summary className="cursor-pointer text-xs text-danger">Void</summary><div className="mt-2"><ActionForm inline action="bk.invVoid" back={back} hidden={{ id: r._id }} submit="Confirm void" variant="danger" fields={[{ name: "reason", label: "Reason", required: true }]} /></div></details>}</td></tr>)}
      </Table>
      {can && <div id="new" className="mt-3 border-t border-border pt-3"><ActionForm action="acc.invCreate" back={back} submit="Create invoice" fields={[
        { name: "customerId", label: "Customer", type: "select", options: custs, required: true }, { name: "date", label: "Invoice date", type: "date", defaultValue: todayYmd() }, { name: "due", label: "Due date (default: customer terms)", type: "date" },
        { name: "lines", label: "Lines", type: "textarea", required: true, span: 3, hint: `${LINES_HINT} ${skus}` }, { name: "notes", label: "Notes" }, { name: "issue", label: "Issue now (post to ledger)", type: "checkbox", defaultValue: true }]} /></div>}
    </Card>
  );
}

async function Payments({ ctx, back, can, custs, name, invoice }: P & { invoice?: string }) {
  const [rows, invs] = await Promise.all([bk.listReceipts(ctx), bk.listTradeInvoices(ctx)]);
  const open = invs.filter((i) => ["open", "partially_paid"].includes(i.status));
  const pre = open.find((i) => i._id === invoice);
  return (
    <Card title="Payments received">
      <Table head={["No.", "Customer", "Date", "Amount", "Unapplied", "Method", ""]} empty={rows.length ? undefined : "No payments yet."}>
        {rows.map((r) => <tr key={r._id}><td className="font-mono text-xs">{r.number}</td><td>{name.get(r.customerId)}</td><td>{fmtDate(r.date)}</td><td className="tabular-nums">{d128(r.amount)}</td><td className="tabular-nums">{d128(r.unapplied)}</td><td className="capitalize">{r.method.replace("_", " ")}</td>
          <td>{can && !fromDecimal128(r.unapplied).isZero() && open.some((i) => i.customerId === r.customerId) && <ActionForm inline action="bk.applyCredit" back={back} hidden={{ source: "receipt", sourceId: r._id }} submit="Apply" variant="ghost" fields={[{ name: "invoiceId", label: "To invoice", type: "select", options: open.filter((i) => i.customerId === r.customerId).map((i) => ({ value: i._id, label: `${i.number} (${fromDecimal128(i.balance).toFixed(2)})` })) }]} />}</td></tr>)}
      </Table>
      {can && <div id="new" className="mt-3 border-t border-border pt-3"><ActionForm action="bk.receipt" back={back} submit="Record payment" fields={[
        { name: "customerId", label: "Customer", type: "select", options: custs, required: true, defaultValue: pre?.customerId },
        { name: "invoiceId", label: "Against invoice (blank = on account)", type: "select", defaultValue: pre?._id, options: [{ value: "", label: "On account" }, ...open.map((i) => ({ value: i._id, label: `${i.number} · ${name.get(i.customerId)} · ${fromDecimal128(i.balance).toFixed(2)}` }))] },
        { name: "amount", label: "Amount (AED)", required: true, defaultValue: pre ? fromDecimal128(pre.balance).toFixed(2) : undefined }, { name: "method", label: "Deposit to", type: "select", options: [{ value: "bank", label: "Bank" }, { value: "cash", label: "Cash" }, { value: "card_clearing", label: "Card" }] },
        { name: "date", label: "Date", type: "date", defaultValue: todayYmd() }, { name: "reference", label: "Cheque / transfer ref." }]} /></div>}
    </Card>
  );
}

async function Credits({ ctx, back, can, custs, name, skus }: P) {
  const [rows, invs] = await Promise.all([bk.listTradeCreditNotes(ctx), bk.listTradeInvoices(ctx)]);
  return (
    <Card title="Credit notes">
      <Table head={["No.", "Customer", "Date", "Total", "Unapplied", "Reason"]} empty={rows.length ? undefined : "No credit notes yet."}>
        {rows.map((r) => <tr key={r._id}><td className="font-mono text-xs">{r.number}</td><td>{name.get(r.customerId)}</td><td>{fmtDate(r.date)}</td><td className="tabular-nums">{d128(r.total)}</td><td className="tabular-nums">{d128(r.unapplied)}</td><td className="text-xs">{r.reason}</td></tr>)}
      </Table>
      {can && <div id="new" className="mt-3 border-t border-border pt-3"><ActionForm action="acc.creditNote" back={back} submit="Issue credit note" fields={[
        { name: "customerId", label: "Customer", type: "select", options: custs, required: true },
        { name: "invoiceId", label: "Against invoice", type: "select", options: [{ value: "", label: "None (on account)" }, ...invs.filter((i) => !["draft", "void"].includes(i.status)).map((i) => ({ value: i._id, label: `${i.number} · ${name.get(i.customerId)}` }))] },
        { name: "reason", label: "Reason", required: true }, { name: "lines", label: "Lines credited", type: "textarea", required: true, span: 3, hint: `${LINES_HINT} ${skus}` }]} /></div>}
    </Card>
  );
}

async function Recurring({ ctx, back, can, custs, name, skus }: P) {
  const rows = await bk.listRecurring(ctx);
  return (
    <Card title="Recurring invoices" action={can && <ActionButton action="bk.recRunDue" back={back} variant="primary">Generate all due now</ActionButton>}>
      <Table head={["Profile", "Customer", "Every", "Next invoice", "Generated", "Status", ""]} empty={rows.length ? undefined : "No recurring profiles yet. Set up a retainer or wellness plan once and invoices are raised for you."}>
        {rows.map((r) => <tr key={r._id}><td>{r.name}</td><td>{name.get(r.customerId)}</td><td className="capitalize">{r.frequency}</td><td>{fmtDate(r.nextDate)}</td><td>{r.generated}</td><td><Badge tone={TONE[r.status]}>{r.status}</Badge></td>
          <td className="space-x-1 whitespace-nowrap">{can && r.status === "active" && <><ActionButton action="bk.recGenerate" back={back} hidden={{ id: r._id }}>Generate</ActionButton><ActionButton action="bk.recStatus" back={back} hidden={{ id: r._id, status: "paused" }} variant="ghost">Pause</ActionButton></>}
            {can && r.status !== "active" && <ActionButton action="bk.recStatus" back={back} hidden={{ id: r._id, status: "active" }} variant="ghost">Resume</ActionButton>}</td></tr>)}
      </Table>
      {can && <div id="new" className="mt-3 border-t border-border pt-3"><ActionForm action="acc.recCreate" back={back} submit="Create profile" fields={[
        { name: "name", label: "Profile name", required: true }, { name: "customerId", label: "Customer", type: "select", options: custs, required: true },
        { name: "frequency", label: "Repeat", type: "select", options: ["weekly", "monthly", "quarterly", "yearly"], defaultValue: "monthly" }, { name: "start", label: "First invoice date", type: "date", defaultValue: todayYmd() },
        { name: "lines", label: "Lines", type: "textarea", required: true, span: 3, hint: `${LINES_HINT} ${skus}` }]} /></div>}
    </Card>
  );
}
