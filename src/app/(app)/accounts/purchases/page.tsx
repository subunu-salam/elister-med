import { requireCtx } from "@/lib/session";
import { todayYmd } from "@/lib/range";
import { Alert, Badge, Card, Table, Tabs } from "@/ui/kit";
import { ActionButton, ActionForm, fmtDate } from "@/ui/forms";
import { fromDecimal128, money } from "@/core/money";
import * as bk from "@/modules/books/service";
import * as coa from "@/modules/ledger/coa";
import { listExpenses } from "@/modules/finance/expenses";
import { listSupplierInvoices, listSupplierPayments, listSuppliers } from "@/modules/procurement/service";
import { AiTag, LINES_HINT, TONE, d128, m } from "../_shared";

const TABS = [{ key: "vendors", label: "Vendors" }, { key: "expenses", label: "Expenses" }, { key: "bills", label: "Bills" }, { key: "payments", label: "Payments made" }, { key: "credits", label: "Vendor credits" }];
type C = Awaited<ReturnType<typeof requireCtx>>;
type P = { ctx: C; back: string; has: (p: string) => boolean };

export default async function PurchasesPage({ searchParams }: { searchParams: Promise<{ tab?: string; error?: string; notice?: string; category?: string; desc?: string; bill?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "expenses";
  const has = (p: string) => ctx.permissions.includes(p as never);
  const p: P = { ctx, back: `/accounts/purchases?tab=${tab}`, has };
  const needsProc = tab !== "expenses" && !has("procurement:view");
  return (
    <div className="space-y-4">
      {sp.error && <Alert>{sp.error}</Alert>}
      {sp.notice && <Alert tone="ok">{sp.notice}</Alert>}
      <Tabs tabs={TABS} active={tab} base="/accounts/purchases" />
      {needsProc ? <Card><p className="text-sm text-muted">Vendors and bills need the procurement permission. Ask an administrator to add it to your role.</p></Card> : <>
        {tab === "vendors" && <Vendors {...p} />}
        {tab === "expenses" && <Expenses {...p} category={sp.category} desc={sp.desc} />}
        {tab === "bills" && <Bills {...p} />}
        {tab === "payments" && <PaymentsMade {...p} bill={sp.bill} />}
        {tab === "credits" && <VendorCredits {...p} />}
      </>}
    </div>
  );
}

async function Vendors({ ctx, back, has }: P) {
  const [sup, bills] = await Promise.all([listSuppliers(ctx), listSupplierInvoices(ctx)]);
  const bal = new Map<string, ReturnType<typeof money>>();
  for (const b of bills) if (["approved", "partially_paid"].includes(b.status)) bal.set(b.supplierId, (bal.get(b.supplierId) ?? money(0)).plus(fromDecimal128(b.balance)));
  return (
    <Card title={`Vendors (${sup.length})`}>
      <Table head={["Name", "TRN", "Terms", "Payable", "Status"]} empty={sup.length ? undefined : "No vendors yet."}>
        {sup.map((s) => <tr key={s._id}><td className="font-medium">{s.name}</td><td className="font-mono text-xs">{s.trn ?? "—"}</td><td>Net {s.termsDays}</td><td className="tabular-nums">{bal.get(s._id) ? m(bal.get(s._id)!) : "—"}</td><td><Badge tone={s.active ? "ok" : "neutral"}>{s.active ? "active" : "inactive"}</Badge></td></tr>)}
      </Table>
      {has("procurement:create") && <div id="new" className="mt-3 border-t border-border pt-3"><ActionForm action="proc.supplier" back={back} submit="Add vendor" fields={[{ name: "name", label: "Vendor name", required: true }, { name: "trn", label: "TRN" }, { name: "terms", label: "Payment terms (days)", type: "number", defaultValue: 30 }]} /></div>}
    </Card>
  );
}

async function Expenses({ ctx, back, has, category, desc }: P & { category?: string; desc?: string }) {
  const [rows, accs] = await Promise.all([listExpenses(ctx), coa.listAccounts(ctx)]);
  const exp = accs.filter((a) => a.type === "expense" && a.active);
  const total = rows.reduce((a, r) => a.plus(fromDecimal128(r.total)), money(0));
  const byCat = new Map<string, number>();
  for (const r of rows) byCat.set(r.categoryName, (byCat.get(r.categoryName) ?? 0) + fromDecimal128(r.total).toNumber());
  return (
    <>
      <Card title={`Expenses (${rows.length})`} action={<span className="text-xs text-muted">Total {m(total)} · <a className="text-primary hover:underline" href="/accounts/reports?r=expenses">By category →</a></span>}>
        <Table head={["Date", "Vendor", "Description", "Account", "Net", "VAT", "Total", "Paid from"]} empty={rows.length ? undefined : "No expenses recorded yet."}>
          {rows.map((r) => <tr key={r._id}><td>{fmtDate(r.date)}</td><td>{r.vendor}</td><td>{r.description}{r.reference && <span className="ms-1 font-mono text-[10px] text-muted">{r.reference}</span>}</td><td className="text-xs">{r.category} {r.categoryName}</td><td className="tabular-nums">{d128(r.net)}</td><td className="tabular-nums">{d128(r.vat)}</td><td className="tabular-nums">{d128(r.total)}</td><td className="capitalize">{r.paidFrom.replace("_", " ")}</td></tr>)}
        </Table>
      </Card>
      {has("ledger:create") && (
        <Card id="new" title={<span className="flex items-center gap-2">Record expense {category && <AiTag>Category suggested</AiTag>}</span>} action={<a href="/accounts/ai#smart" className="text-xs text-primary hover:underline">Not sure of the account? Ask AI →</a>}>
          <ActionForm action="exp.add" back={back} submit="Save expense" fields={[
            { name: "vendor", label: "Vendor", required: true }, { name: "description", label: "Description", required: true, defaultValue: desc }, { name: "reference", label: "Tax invoice no." },
            { name: "category", label: "Expense account", type: "select", defaultValue: category, options: exp.map((a) => ({ value: a.code, label: `${a.code} ${a.name}` })) }, { name: "net", label: "Amount excl. VAT (AED)", required: true },
            { name: "vat", label: "VAT", type: "select", options: [{ value: "STD", label: "5% standard" }, { value: "ZERO", label: "Zero-rated" }, { value: "EXEMPT", label: "Exempt / no VAT" }] },
            { name: "paidFrom", label: "Paid through", type: "select", options: [{ value: "bank", label: "Bank" }, { value: "cash", label: "Cash" }, { value: "petty_cash", label: "Petty cash" }, { value: "card_clearing", label: "Company card" }] },
            { name: "treatment", label: "Corporate tax treatment", type: "select", options: [{ value: "deductible", label: "Fully deductible" }, { value: "entertainment_50", label: "Client entertainment (50%)" }, { value: "non_deductible", label: "Not deductible" }] },
            { name: "date", label: "Date", type: "date", defaultValue: todayYmd() },
          ]} />
        </Card>
      )}
    </>
  );
}

async function Bills({ ctx, back, has }: P) {
  const [bills, sup] = await Promise.all([listSupplierInvoices(ctx), listSuppliers(ctx)]);
  const name = new Map(sup.map((s) => [s._id, s.name]));
  const now = Date.now();
  return (
    <Card title={`Bills (${bills.length})`}>
      <Table head={["Bill no.", "Vendor", "Date", "Due", "Total", "Balance", "Status", ""]} empty={bills.length ? undefined : "No bills yet."}>
        {bills.map((b) => { const late = ["approved", "partially_paid"].includes(b.status) && b.dueDate.getTime() < now; return (
          <tr key={b._id}><td className="font-mono text-xs">{b.invoiceNo}</td><td>{name.get(b.supplierId)}</td><td>{fmtDate(b.invoiceDate)}</td><td className={late ? "text-danger" : ""}>{fmtDate(b.dueDate)}</td><td className="tabular-nums">{d128(b.total)}</td><td className="tabular-nums">{d128(b.balance)}</td>
            <td><Badge tone={late ? "danger" : TONE[b.status] ?? "neutral"}>{late ? "overdue" : b.status.replace(/_/g, " ")}</Badge></td>
            <td className="space-x-1 whitespace-nowrap">{has("procurement:approve") && b.status === "pending_approval" && <ActionButton action="proc.invoiceApprove" back={back} hidden={{ id: b._id }} variant="primary">Approve</ActionButton>}
              {["approved", "partially_paid"].includes(b.status) && <a className="text-xs text-primary hover:underline" href={`/accounts/purchases?tab=payments&bill=${b._id}#new`}>Pay</a>}</td></tr>); })}
      </Table>
      {has("procurement:create") && sup.length > 0 && <div id="new" className="mt-3 border-t border-border pt-3"><ActionForm action="proc.invoice" back={back} submit="Record bill" fields={[
        { name: "supplierId", label: "Vendor", type: "select", options: sup.map((s) => ({ value: s._id, label: s.name })), required: true }, { name: "invoiceNo", label: "Bill / invoice no.", required: true },
        { name: "invoiceDate", label: "Bill date", type: "date", required: true, defaultValue: todayYmd() }, { name: "dueDate", label: "Due date", type: "date", required: true },
        { name: "net", label: "Amount excl. VAT", required: true }, { name: "vat", label: "VAT amount", defaultValue: "0" }]} />
        <p className="mt-2 text-xs text-muted">Bills linked to a purchase order are matched to goods received in Procurement. Approval posts the bill to the ledger (four-eyes).</p></div>}
    </Card>
  );
}

async function PaymentsMade({ ctx, back, has, bill }: P & { bill?: string }) {
  const [pays, bills, sup] = await Promise.all([listSupplierPayments(ctx), listSupplierInvoices(ctx), listSuppliers(ctx)]);
  const name = new Map(sup.map((s) => [s._id, s.name]));
  const billNo = new Map(bills.map((b) => [b._id, b.invoiceNo]));
  const open = bills.filter((b) => ["approved", "partially_paid"].includes(b.status));
  const pre = open.find((b) => b._id === bill);
  return (
    <Card title="Payments made">
      <Table head={["Date", "Vendor", "Bill", "Amount", "Paid from"]} empty={pays.length ? undefined : "No vendor payments yet."}>
        {pays.map((p) => <tr key={p._id}><td>{fmtDate(p.at)}</td><td>{name.get(p.supplierId)}</td><td className="font-mono text-xs">{billNo.get(p.invoiceId) ?? "—"}</td><td className="tabular-nums">{d128(p.amount)}</td><td className="capitalize">{p.method}</td></tr>)}
      </Table>
      {has("procurement:update") && open.length > 0 && <div id="new" className="mt-3 border-t border-border pt-3"><ActionForm action="proc.pay" back={back} submit="Record payment" fields={[
        { name: "invoiceId", label: "Bill", type: "select", defaultValue: pre?._id, options: open.map((b) => ({ value: b._id, label: `${b.invoiceNo} · ${name.get(b.supplierId)} · ${fromDecimal128(b.balance).toFixed(2)}` })), required: true },
        { name: "amount", label: "Amount", required: true, defaultValue: pre ? fromDecimal128(pre.balance).toFixed(2) : undefined }, { name: "method", label: "Paid from", type: "select", options: [{ value: "bank", label: "Bank" }, { value: "cash", label: "Cash" }] }]} /></div>}
    </Card>
  );
}

async function VendorCredits({ ctx, back, has }: P) {
  const [rows, sup, bills] = await Promise.all([bk.listVendorCredits(ctx), listSuppliers(ctx), listSupplierInvoices(ctx)]);
  const name = new Map(sup.map((s) => [s._id, s.name]));
  return (
    <Card title="Vendor credits">
      <Table head={["No.", "Vendor", "Date", "Total", "Unapplied", "Reason"]} empty={rows.length ? undefined : "No vendor credits yet."}>
        {rows.map((r) => <tr key={r._id}><td className="font-mono text-xs">{r.number}</td><td>{name.get(r.supplierId)}</td><td>{fmtDate(r.date)}</td><td className="tabular-nums">{d128(r.total)}</td><td className="tabular-nums">{d128(r.unapplied)}</td><td className="text-xs">{r.reason}</td></tr>)}
      </Table>
      {has("ledger:create") && sup.length > 0 && <div id="new" className="mt-3 border-t border-border pt-3"><ActionForm action="acc.vendorCredit" back={back} submit="Record vendor credit" fields={[
        { name: "supplierId", label: "Vendor", type: "select", options: sup.map((s) => ({ value: s._id, label: s.name })), required: true },
        { name: "supplierInvoiceId", label: "Against bill (optional)", type: "select", options: [{ value: "", label: "None" }, ...bills.filter((i) => ["approved", "partially_paid"].includes(i.status)).map((i) => ({ value: i._id, label: `${i.invoiceNo} · ${name.get(i.supplierId)} · ${fromDecimal128(i.balance).toFixed(2)}` }))] },
        { name: "reason", label: "Reason", required: true }, { name: "lines", label: "Lines", type: "textarea", required: true, span: 3, hint: `${LINES_HINT} Default account 5800.` }]} /></div>}
    </Card>
  );
}
