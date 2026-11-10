import { requireCtx } from "@/lib/session";
import { fromDecimal128 } from "@/core/money";
import { Alert, Badge, Card, NoAccess, PageHeader, Stat, Table, Tabs, aed } from "@/ui/kit";
import { ActionButton, ActionForm, fmtDate } from "@/ui/forms";
import { apAging, listPurchaseOrders, listPurchaseRequests, listSupplierInvoices, listSuppliers } from "@/modules/procurement/service";
import { listItems } from "@/modules/inventory/service";

const TABS = [{ key: "requests", label: "Requests" }, { key: "orders", label: "Orders & receiving" }, { key: "invoices", label: "Supplier invoices & payment" }, { key: "suppliers", label: "Suppliers" }];

export default async function ProcurementPage({ searchParams }: { searchParams: Promise<{ tab?: string; error?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  if (!ctx.permissions.includes("procurement:view")) return <NoAccess what="procurement" />;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "requests";
  const back = `/procurement?tab=${tab}`;
  const can = (p: string) => ctx.permissions.includes(p as never);
  const [suppliers, prs, pos, invs, items, aging] = await Promise.all([listSuppliers(ctx), listPurchaseRequests(ctx), listPurchaseOrders(ctx), listSupplierInvoices(ctx), listItems(ctx).catch(() => []), apAging(ctx)]);
  const sup = new Map(suppliers.map((s) => [s._id, s.name])), item = new Map(items.map((i) => [i._id, i.name]));
  const itemOpts = items.map((i) => ({ value: i._id, label: i.name }));
  const supOpts = suppliers.map((s) => ({ value: s._id, label: s.name }));

  return (
    <div className="space-y-4">
      <PageHeader title="Procurement and payables" sub="Reorder → request → approval → order → goods receipt → supplier invoice → payment" />
      {sp.error && <Alert>{sp.error}</Alert>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="Payables outstanding" value={aed(aging.total.toFixed(2))} /><Stat label="Open requests" value={prs.filter((p) => p.status === "draft").length} /><Stat label="Orders in progress" value={pos.filter((p) => ["issued", "partially_received"].includes(p.status)).length} /><Stat label="Invoices to approve" value={invs.filter((i) => i.status === "pending_approval").length} tone={invs.some((i) => i.status === "pending_approval") ? "warn" : undefined} /></div>
      <Tabs tabs={TABS} active={tab} base="/procurement" />

      {tab === "requests" && (
        <>
          <Card title="Purchase requests" action={can("procurement:create") && <ActionButton action="proc.reorder" back={back}>Create from reorder alerts</ActionButton>}>
            <Table head={["No.", "Lines", "Status", ""]} empty={prs.length ? undefined : "No requests."}>
              {prs.map((p) => <tr key={p._id}><td className="font-mono text-xs">{p.number}{p.auto && <Badge>auto</Badge>}</td><td>{p.lines.map((l) => `${item.get(l.itemId) ?? l.itemId} ×${l.qty}`).join(", ")}</td><td><Badge tone={p.status === "approved" ? "ok" : p.status === "rejected" ? "danger" : "warn"}>{p.status}</Badge></td>
                <td>{p.status === "draft" && can("procurement:approve") && <div className="flex gap-1"><ActionButton action="proc.prDecide" back={back} hidden={{ id: p._id, decision: "approve" }}>Approve</ActionButton><ActionButton action="proc.prDecide" back={back} hidden={{ id: p._id, decision: "reject" }} variant="ghost">Reject</ActionButton></div>}</td></tr>)}
            </Table>
          </Card>
          {can("procurement:create") && itemOpts.length > 0 && <Card title="New request"><ActionForm action="proc.pr" back={back} submit="Create request" fields={[{ name: "itemId", label: "Item", type: "select", options: itemOpts }, { name: "qty", label: "Quantity", type: "number", required: true }, { name: "note", label: "Note" }]} /><p className="mt-2 text-xs text-muted">The requester cannot approve their own request.</p></Card>}
        </>
      )}

      {tab === "orders" && (
        <>
          <Card title="Purchase orders">
            <Table head={["No.", "Supplier", "Lines (received/ordered)", "Status", ""]} empty={pos.length ? undefined : "No orders."}>
              {pos.map((p) => <tr key={p._id}><td className="font-mono text-xs">{p.number}</td><td>{sup.get(p.supplierId)}</td><td>{p.lines.map((l) => `${item.get(l.itemId) ?? l.itemId} ${l.received}/${l.qty} @ ${fromDecimal128(l.unitCost).toFixed(2)}`).join("; ")}</td><td><Badge tone={p.status === "received" ? "ok" : "info"}>{p.status.replace("_", " ")}</Badge></td>
                <td>{p.status === "draft" && can("procurement:update") && <ActionButton action="proc.poIssue" back={back} hidden={{ id: p._id }}>Issue</ActionButton>}
                  {["issued", "partially_received"].includes(p.status) && can("procurement:update") && <ActionForm inline action="proc.grn" back={back} hidden={{ poId: p._id }} submit="Receive" variant="outline" fields={[{ name: "itemId", label: "Item", type: "select", options: p.lines.map((l) => ({ value: l.itemId, label: item.get(l.itemId) ?? l.itemId })) }, { name: "qty", label: "Qty", type: "number", required: true }, { name: "batchNo", label: "Batch", required: true }, { name: "expiry", label: "Expiry", type: "date", required: true }, { name: "location", label: "Location", defaultValue: "pharmacy" }]} />}</td></tr>)}
            </Table>
          </Card>
          {can("procurement:create") && suppliers.length > 0 && itemOpts.length > 0 && <Card title="New purchase order"><ActionForm action="proc.po" back={back} submit="Create order" fields={[{ name: "supplierId", label: "Supplier", type: "select", options: supOpts }, { name: "prId", label: "Approved request ID (optional)" }, { name: "itemId", label: "Item", type: "select", options: itemOpts }, { name: "qty", label: "Quantity", type: "number", required: true }, { name: "unitCost", label: "Unit cost (AED)", required: true }]} /></Card>}
        </>
      )}

      {tab === "invoices" && (
        <>
          <Card title="Supplier invoices">
            <Table head={["Invoice", "Supplier", "Total", "Balance", "Due", "Status", ""]} empty={invs.length ? undefined : "None."}>
              {invs.map((i) => <tr key={i._id}><td>{i.invoiceNo}</td><td>{sup.get(i.supplierId)}</td><td>{aed(fromDecimal128(i.total).toFixed(2))}</td><td>{aed(fromDecimal128(i.balance).toFixed(2))}</td><td>{fmtDate(i.dueDate)}</td><td><Badge tone={i.status === "paid" ? "ok" : i.status === "pending_approval" ? "warn" : "info"}>{i.status.replace("_", " ")}</Badge></td>
                <td>{i.status === "pending_approval" && can("procurement:approve") && <ActionButton action="proc.invoiceApprove" back={back} hidden={{ id: i._id }}>Approve</ActionButton>}
                  {["approved", "partially_paid"].includes(i.status) && can("ledger:create") && <ActionForm inline action="proc.pay" back={back} hidden={{ invoiceId: i._id }} submit="Pay" variant="outline" fields={[{ name: "amount", label: "Amount", required: true, defaultValue: fromDecimal128(i.balance).toFixed(2) }, { name: "method", label: "From", type: "select", options: ["bank", "cash"] }]} />}</td></tr>)}
            </Table>
            <p className="mt-2 text-xs text-muted">Approval posts to the ledger (GRNI cleared, VAT, payable). The person who recorded an invoice cannot approve it.</p>
          </Card>
          {can("procurement:create") && suppliers.length > 0 && <Card title="Record supplier invoice"><ActionForm action="proc.invoice" back={back} submit="Record" fields={[{ name: "supplierId", label: "Supplier", type: "select", options: supOpts }, { name: "poId", label: "Purchase order ID" }, { name: "invoiceNo", label: "Invoice no.", required: true }, { name: "invoiceDate", label: "Invoice date", type: "date", required: true }, { name: "dueDate", label: "Due date", type: "date", required: true }, { name: "net", label: "Net (AED)", required: true }, { name: "vat", label: "VAT (AED)", defaultValue: "0" }]} /></Card>}
          <Card title="Payables aging"><Table head={["Bucket", "Invoices", "Amount"]}>{aging.buckets.map((b) => <tr key={b.label}><td>{b.label}</td><td>{b.count}</td><td className="tabular-nums">{aed(b.amount.toFixed(2))}</td></tr>)}</Table></Card>
        </>
      )}

      {tab === "suppliers" && (
        <>
          <Card title="Suppliers"><Table head={["Name", "TRN", "Terms (days)"]} empty={suppliers.length ? undefined : "No suppliers."}>{suppliers.map((s) => <tr key={s._id}><td>{s.name}</td><td className="font-mono text-xs">{s.trn ?? "—"}</td><td>{s.termsDays}</td></tr>)}</Table></Card>
          {can("procurement:create") && <Card title="Add supplier"><ActionForm action="proc.supplier" back={back} submit="Add" fields={[{ name: "name", label: "Name", required: true }, { name: "trn", label: "Tax registration number" }, { name: "terms", label: "Payment terms (days)", type: "number", defaultValue: 30 }]} /></Card>}
        </>
      )}
    </div>
  );
}
