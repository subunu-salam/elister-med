import { requireCtx } from "@/lib/session";
import { fromDecimal128 } from "@/core/money";
import { Alert, Badge, Card, NoAccess, PageHeader, Stat, Table, Tabs, aed } from "@/ui/kit";
import { ActionForm, fmtDate } from "@/ui/forms";
import { inventoryValuation, listBatches, listItems, nearExpiry, reorderAlerts } from "@/modules/inventory/service";

const TABS = [{ key: "items", label: "Items" }, { key: "batches", label: "Batches & adjustments" }, { key: "alerts", label: "Alerts" }];

export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ tab?: string; error?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  if (!ctx.permissions.includes("inventory:view")) return <NoAccess what="inventory" />;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "items";
  const back = `/inventory?tab=${tab}`;
  const can = (p: string) => ctx.permissions.includes(p as never);
  const [items, batches, val, low, exp] = await Promise.all([listItems(ctx), listBatches(ctx), inventoryValuation(ctx), reorderAlerts(ctx), nearExpiry(ctx, 90)]);
  const onHand = new Map<string, number>();
  for (const b of batches) onHand.set(b.itemId, (onHand.get(b.itemId) ?? 0) + b.qtyOnHand);
  const name = new Map(items.map((i) => [i._id, i.name]));

  return (
    <div className="space-y-4">
      <PageHeader title="Inventory" sub="Batch-level stock, FEFO allocation, no negative balances" />
      {sp.error && <Alert>{sp.error}</Alert>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label="Stock value (at cost)" value={aed(val.total.toFixed(2))} /><Stat label="Items" value={items.length} /><Stat label="Low stock" value={low.length} tone={low.length ? "warn" : undefined} /><Stat label="Near expiry (90d)" value={exp.length} tone={exp.length ? "warn" : undefined} /></div>
      <Tabs tabs={TABS} active={tab} base="/inventory" />

      {tab === "items" && (
        <>
          <Card title="Items">
            <Table head={["SKU", "Name", "Category", "On hand", "Reorder at", "Price"]} empty={items.length ? undefined : "No items yet."}>
              {items.map((i) => <tr key={i._id}><td className="font-mono text-xs">{i.sku}</td><td>{i.name}{i.controlled && <Badge tone="danger">controlled</Badge>}</td><td className="capitalize">{i.category}</td><td className="tabular-nums">{onHand.get(i._id) ?? 0}</td><td>{i.reorderLevel || "—"}</td><td>{i.sellingPrice ? aed(fromDecimal128(i.sellingPrice).toFixed(2)) : "—"}</td></tr>)}
            </Table>
          </Card>
          {(can("inventory:create") || can("pharmacy:create")) && <Card title="Add item"><ActionForm action="inv.item" back={back} submit="Add item" fields={[
            { name: "sku", label: "SKU", required: true }, { name: "name", label: "Name", required: true }, { name: "generic", label: "Generic name" },
            { name: "category", label: "Category", type: "select", options: ["medicine", "consumable", "lab", "dental", "surgical", "office", "asset"] }, { name: "strength", label: "Strength" }, { name: "form", label: "Dosage form" },
            { name: "price", label: "Selling price (AED)" }, { name: "reorderLevel", label: "Reorder level", type: "number" }, { name: "reorderQty", label: "Reorder quantity", type: "number" }, { name: "controlled", label: "Controlled medicine", type: "checkbox" }]} /></Card>}
        </>
      )}

      {tab === "batches" && (
        <Card title="Batches">
          <Table head={["Item", "Batch", "Location", "Expiry", "Qty", "Unit cost", ""]} empty={batches.length ? undefined : "No stock. Receive goods through Procurement."}>
            {batches.map((b) => <tr key={b._id}><td>{name.get(b.itemId)}</td><td className="font-mono text-xs">{b.batchNo}</td><td>{b.locationId}</td><td className={b.expiry < new Date() ? "text-danger" : ""}>{fmtDate(b.expiry)}</td><td className="tabular-nums">{b.qtyOnHand}</td><td>{fromDecimal128(b.unitCost).toFixed(2)}</td>
              <td>{can("inventory:update") && <ActionForm inline action="inv.adjust" back={back} hidden={{ batchId: b._id }} submit="Adjust" variant="ghost" fields={[{ name: "delta", label: "± qty", type: "number", required: true }, { name: "reason", label: "Reason", required: true }, { name: "kind", label: "Type", type: "select", options: ["adjustment", "wastage"] }]} />}</td></tr>)}
          </Table>
          <p className="mt-2 text-xs text-muted">Every adjustment posts to the ledger (Stock Adjustments) and cannot take a batch below zero.</p>
        </Card>
      )}

      {tab === "alerts" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="At or below reorder level"><Table head={["Item", "On hand", "Level"]} empty="Nothing below its reorder level.">{low.map((a) => <tr key={a.item._id}><td>{a.item.name}</td><td>{a.onHand}</td><td>{a.item.reorderLevel}</td></tr>)}</Table></Card>
          <Card title="Expiring within 90 days"><Table head={["Item", "Batch", "Expiry", "Qty"]} empty="No batches expiring soon.">{exp.map((b) => <tr key={b._id}><td>{name.get(b.itemId)}</td><td className="font-mono text-xs">{b.batchNo}</td><td>{fmtDate(b.expiry)}</td><td>{b.qtyOnHand}</td></tr>)}</Table></Card>
        </div>
      )}
    </div>
  );
}
