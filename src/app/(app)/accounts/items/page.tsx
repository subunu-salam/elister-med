import { requireCtx } from "@/lib/session";
import { Alert, Badge, Card, Table } from "@/ui/kit";
import { ActionButton, ActionForm } from "@/ui/forms";
import * as coa from "@/modules/ledger/coa";
import { listItems } from "@/modules/accounts/items";
import { d128 } from "../_shared";

export default async function ItemsPage({ searchParams }: { searchParams: Promise<{ error?: string; q?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const can = ctx.permissions.includes("ledger:create" as never);
  const [all, accs] = await Promise.all([listItems(ctx), coa.listAccounts(ctx)]);
  const q = sp.q?.toLowerCase().trim();
  const rows = q ? all.filter((i) => `${i.sku} ${i.name} ${i.description ?? ""}`.toLowerCase().includes(q)) : all;
  const acc = (type: string) => accs.filter((a) => a.type === type && a.active).map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }));
  const back = "/accounts/items";
  return (
    <div className="space-y-4">
      {sp.error && <Alert>{sp.error}</Alert>}
      <Card title={`Items (${rows.length})`} action={<form className="flex gap-2"><input name="q" defaultValue={sp.q} placeholder="Search items" aria-label="Search items" className="rounded-ui border border-border bg-surface px-3 py-1.5 text-sm" /></form>}>
        <Table head={["SKU", "Name", "Type", "Selling rate", "VAT", "Income acct", "Purchase rate", "Status", ""]} empty={all.length ? "No items match." : "No items yet. Add the services and products you sell, then pick them on invoices with @SKU."}>
          {rows.map((i) => <tr key={i._id}><td className="font-mono text-xs">{i.sku}</td><td><div className="font-medium">{i.name}</div>{i.description && <div className="text-xs text-muted">{i.description}</div>}</td><td className="capitalize">{i.kind}</td>
            <td className="tabular-nums">{d128(i.rate)}{i.unit && <span className="text-xs text-muted"> / {i.unit}</span>}</td><td>{i.vatRate === "STD" ? "5%" : i.vatRate.toLowerCase()}</td><td className="font-mono text-xs">{i.incomeCode}</td>
            <td className="tabular-nums">{i.purchaseRate ? d128(i.purchaseRate) : "—"}</td><td><Badge tone={i.active ? "ok" : "neutral"}>{i.active ? "active" : "inactive"}</Badge></td>
            <td className="whitespace-nowrap">{can && <>
              <details className="inline-block align-top"><summary className="cursor-pointer text-xs text-primary">Edit rate</summary><div className="mt-2"><ActionForm inline action="acc.itemRate" back={back} hidden={{ id: i._id }} submit="Save" variant="outline" fields={[{ name: "rate", label: "New rate", required: true }]} /></div></details>
              <ActionButton action="acc.itemActive" back={back} hidden={{ id: i._id, active: i.active ? "0" : "1" }} variant="ghost">{i.active ? "Deactivate" : "Activate"}</ActionButton></>}</td></tr>)}
        </Table>
      </Card>
      {can && (
        <Card id="new" title="New item">
          <ActionForm action="acc.item" back={back} submit="Save item" fields={[
            { name: "sku", label: "SKU", required: true, placeholder: "MED-PRE" }, { name: "name", label: "Name", required: true, placeholder: "Pre-employment medical" },
            { name: "kind", label: "Type", type: "select", options: [{ value: "service", label: "Service" }, { value: "goods", label: "Goods" }] },
            { name: "rate", label: "Selling rate (AED)", required: true }, { name: "unit", label: "Unit", placeholder: "visit, pcs, hr" },
            { name: "vat", label: "VAT", type: "select", options: [{ value: "STD", label: "5% standard" }, { value: "ZERO", label: "Zero-rated" }, { value: "EXEMPT", label: "Exempt" }] },
            { name: "incomeCode", label: "Sales account", type: "select", options: acc("income"), defaultValue: "4500" },
            { name: "purchaseRate", label: "Purchase rate (optional)" }, { name: "expenseCode", label: "Purchase account (optional)", type: "select", options: [{ value: "", label: "—" }, ...acc("expense")] },
            { name: "description", label: "Description", span: 3 },
          ]} />
        </Card>
      )}
    </div>
  );
}
