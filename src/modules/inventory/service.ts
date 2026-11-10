import Decimal from "decimal.js";
import type { ClientSession, Decimal128 } from "mongodb";
import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { fromDecimal128, money, round2, sum, toDecimal128 } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { accountBySystem } from "@/modules/ledger/accounts";
import { postJournalSystem } from "@/modules/ledger/journal";

export type Category = "medicine" | "consumable" | "lab" | "dental" | "surgical" | "office" | "asset";
export type Item = {
  _id: string; sku: string; name: string; genericName?: string; category: Category; uom: string; reorderLevel: number; reorderQty: number;
  sellingPrice?: Decimal128; taxCode: string; controlled: boolean; strength?: string; form?: string; manufacturer?: string; storage?: string;
  regulatoryCode?: string; active: boolean;
};
export type Batch = { _id: string; itemId: string; locationId: string; batchNo: string; expiry: Date; qtyOnHand: number; unitCost: Decimal128; supplierId?: string; receivedAt: Date };
export type Movement = {
  _id: string; itemId: string; batchId: string; locationId: string; type: "receipt" | "dispense" | "adjustment" | "wastage" | "return_in" | "return_out" | "transfer_out" | "transfer_in";
  qty: number; unitCost: Decimal128; refType: string; refId: string; at: Date; by: string;
};
export type Allocation = { batchId: string; batchNo: string; qty: number; unitCost: Decimal128 };

const items = (o: string) => tenantCol<Item>(o, "inv_items");
const batches = (o: string) => tenantCol<Batch>(o, "inv_batches");
const moves = (o: string) => tenantCol<Movement>(o, "inv_movements");

const ItemInput = z.object({
  sku: z.string().min(2), name: z.string().min(2), genericName: z.string().optional(),
  category: z.enum(["medicine", "consumable", "lab", "dental", "surgical", "office", "asset"]), uom: z.string().default("unit"),
  reorderLevel: z.number().int().min(0).default(0), reorderQty: z.number().int().min(0).default(0),
  sellingPrice: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(), taxCode: z.string().default("STD"), controlled: z.boolean().default(false),
  strength: z.string().optional(), form: z.string().optional(), manufacturer: z.string().optional(), storage: z.string().optional(), regulatoryCode: z.string().optional(),
});

export async function createItem(ctx: Ctx, input: z.input<typeof ItemInput>): Promise<Item> {
  if (!ctx.permissions.includes("inventory:create") && !ctx.permissions.includes("pharmacy:create")) throw new AppError("FORBIDDEN", "Missing permission inventory:create");
  const p = ItemInput.safeParse(input);
  if (!p.success) throw new AppError("VALIDATION", p.error.message);
  const { sellingPrice, ...rest } = p.data;
  const item: Item = { _id: newId(), ...rest, ...(sellingPrice ? { sellingPrice: toDecimal128(money(sellingPrice)) } : {}), active: true };
  try {
    await withTransaction(async (s) => {
      await items(ctx.orgId).insertOne(item, s);
      await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "item.create", resource: "item", resourceId: item._id, after: { sku: item.sku } });
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new AppError("CONFLICT", `SKU ${item.sku} already exists`);
    throw e;
  }
  return item;
}

export const inventoryAccountSystem = (i: Item) => (i.category === "medicine" ? "inventory_pharmacy" : "inventory_consumables");

async function loadItem(orgId: string, id: string, s?: ClientSession): Promise<Item> {
  const i = await items(orgId).findOne({ _id: id } as never, s);
  if (!i || !i.active) throw new AppError("NOT_FOUND", "Item not found");
  return i;
}
const posInt = (n: number, label: string) => { if (!Number.isInteger(n) || n <= 0) throw new AppError("VALIDATION", `${label} must be a positive whole number`); };

async function addMovement(ctx: Ctx, m: Omit<Movement, "_id" | "at" | "by">, s: ClientSession) {
  await moves(ctx.orgId).insertOne({ _id: newId(), ...m, at: new Date(), by: ctx.userId }, s);
}

/** Internal: callers (procurement GRN) authorise and post the journal. Cost must be a 2-dp amount. */
export async function receiveIntoStock(
  ctx: Ctx, r: { itemId: string; locationId: string; batchNo: string; expiry: Date; qty: number; unitCost: Decimal; supplierId?: string; refType: string; refId: string }, s: ClientSession,
): Promise<{ batch: Batch; value: Decimal }> {
  posInt(r.qty, "Quantity");
  if (r.unitCost.isNegative() || r.unitCost.decimalPlaces() > 2) throw new AppError("VALIDATION", "Unit cost must be non-negative with at most 2 decimals");
  if (!r.batchNo.trim()) throw new AppError("VALIDATION", "Batch number required");
  await loadItem(ctx.orgId, r.itemId, s);
  const existing = await batches(ctx.orgId).findOne({ itemId: r.itemId, locationId: r.locationId, batchNo: r.batchNo } as never, s);
  let batch: Batch;
  if (existing) {
    if (!fromDecimal128(existing.unitCost).equals(r.unitCost)) throw new AppError("VALIDATION", "Batch already exists with a different unit cost; use a new batch number");
    await batches(ctx.orgId).updateOne({ _id: existing._id } as never, { $inc: { qtyOnHand: r.qty } } as never, s);
    batch = { ...existing, qtyOnHand: existing.qtyOnHand + r.qty };
  } else {
    batch = { _id: newId(), itemId: r.itemId, locationId: r.locationId, batchNo: r.batchNo, expiry: r.expiry, qtyOnHand: r.qty, unitCost: toDecimal128(r.unitCost), supplierId: r.supplierId, receivedAt: new Date() };
    await batches(ctx.orgId).insertOne(batch, s);
  }
  await addMovement(ctx, { itemId: r.itemId, batchId: batch._id, locationId: r.locationId, type: "receipt", qty: r.qty, unitCost: toDecimal128(r.unitCost), refType: r.refType, refId: r.refId }, s);
  return { batch, value: r.unitCost.times(r.qty) };
}

/** FEFO: earliest-expiry first, expired batches skipped, never below zero. Throws CONFLICT when stock is insufficient. */
export async function allocateFefo(
  ctx: Ctx, a: { itemId: string; locationId: string; qty: number; refType: string; refId: string }, s: ClientSession,
): Promise<Allocation[]> {
  posInt(a.qty, "Quantity");
  const now = new Date();
  const candidates = await batches(ctx.orgId).find({ itemId: a.itemId, locationId: a.locationId, qtyOnHand: { $gt: 0 }, expiry: { $gt: now } } as never, { sort: { expiry: 1, receivedAt: 1 }, session: s });
  let remaining = a.qty;
  const out: Allocation[] = [];
  for (const b of candidates) {
    if (remaining === 0) break;
    const take = Math.min(remaining, b.qtyOnHand);
    const res = await batches(ctx.orgId).updateOne({ _id: b._id, qtyOnHand: { $gte: take } } as never, { $inc: { qtyOnHand: -take } } as never, s);
    if (res.matchedCount === 0) throw new AppError("CONFLICT", "Stock changed concurrently, retry");
    await addMovement(ctx, { itemId: a.itemId, batchId: b._id, locationId: a.locationId, type: "dispense", qty: -take, unitCost: b.unitCost, refType: a.refType, refId: a.refId }, s);
    out.push({ batchId: b._id, batchNo: b.batchNo, qty: take, unitCost: b.unitCost });
    remaining -= take;
  }
  if (remaining > 0) throw new AppError("CONFLICT", "Insufficient unexpired stock");
  return out;
}

export function allocationValue(al: Allocation[]): Decimal {
  return sum(al.map((x) => fromDecimal128(x.unitCost).times(x.qty)));
}

export async function returnToBatch(ctx: Ctx, r: { batchId: string; qty: number; refType: string; refId: string }, s: ClientSession): Promise<Decimal> {
  posInt(r.qty, "Quantity");
  const b = await batches(ctx.orgId).findOne({ _id: r.batchId } as never, s);
  if (!b) throw new AppError("NOT_FOUND", "Batch not found");
  await batches(ctx.orgId).updateOne({ _id: b._id } as never, { $inc: { qtyOnHand: r.qty } } as never, s);
  await addMovement(ctx, { itemId: b.itemId, batchId: b._id, locationId: b.locationId, type: "return_in", qty: r.qty, unitCost: b.unitCost, refType: r.refType, refId: r.refId }, s);
  return fromDecimal128(b.unitCost).times(r.qty);
}

/** Authorised stock adjustment / wastage. Posts Dr/Cr Inventory vs Stock Adjustments. Cannot take a batch negative. */
export async function adjustStock(ctx: Ctx, input: { batchId: string; delta: number; reason: string; kind?: "adjustment" | "wastage" }): Promise<Batch> {
  assertPermission(ctx, "inventory:update");
  if (!Number.isInteger(input.delta) || input.delta === 0) throw new AppError("VALIDATION", "Delta must be a non-zero whole number");
  if (!input.reason.trim()) throw new AppError("VALIDATION", "Reason required");
  const kind = input.kind ?? "adjustment";
  if (kind === "wastage" && input.delta > 0) throw new AppError("VALIDATION", "Wastage must reduce stock");
  return withTransaction(async (s) => {
    const b = await batches(ctx.orgId).findOne({ _id: input.batchId } as never, s);
    if (!b) throw new AppError("NOT_FOUND", "Batch not found");
    const item = await loadItem(ctx.orgId, b.itemId, s);
    const res = await batches(ctx.orgId).updateOne(
      { _id: b._id, ...(input.delta < 0 ? { qtyOnHand: { $gte: -input.delta } } : {}) } as never, { $inc: { qtyOnHand: input.delta } } as never, s);
    if (res.matchedCount === 0) throw new AppError("VALIDATION", "Adjustment would make stock negative");
    await addMovement(ctx, { itemId: b.itemId, batchId: b._id, locationId: b.locationId, type: kind, qty: input.delta, unitCost: b.unitCost, refType: kind, refId: b._id }, s);
    const value = round2(fromDecimal128(b.unitCost).times(Math.abs(input.delta)));
    const inv = (await accountBySystem(ctx.orgId, inventoryAccountSystem(item)))._id, adj = (await accountBySystem(ctx.orgId, "stock_adjustment"))._id;
    const gain = input.delta > 0;
    await postJournalSystem(ctx, {
      date: new Date(), memo: `Stock ${kind}: ${input.reason}`, sourceRef: { type: "stock_adjustment", id: b._id }, idempotencyKey: `stockadj:${newId()}`,
      lines: [{ accountId: gain ? inv : adj, debit: value.toFixed(2) }, { accountId: gain ? adj : inv, credit: value.toFixed(2) }],
    }, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: `stock.${kind}`, resource: "batch", resourceId: b._id, after: { delta: input.delta, reason: input.reason } });
    return { ...b, qtyOnHand: b.qtyOnHand + input.delta };
  });
}

export async function transferStock(ctx: Ctx, input: { batchId: string; toLocationId: string; qty: number }): Promise<void> {
  assertPermission(ctx, "inventory:update");
  posInt(input.qty, "Quantity");
  await withTransaction(async (s) => {
    const b = await batches(ctx.orgId).findOne({ _id: input.batchId } as never, s);
    if (!b) throw new AppError("NOT_FOUND", "Batch not found");
    if (b.locationId === input.toLocationId) throw new AppError("VALIDATION", "Source and destination are the same");
    const res = await batches(ctx.orgId).updateOne({ _id: b._id, qtyOnHand: { $gte: input.qty } } as never, { $inc: { qtyOnHand: -input.qty } } as never, s);
    if (res.matchedCount === 0) throw new AppError("VALIDATION", "Insufficient stock to transfer");
    const dest = await batches(ctx.orgId).findOne({ itemId: b.itemId, locationId: input.toLocationId, batchNo: b.batchNo } as never, s);
    if (dest) await batches(ctx.orgId).updateOne({ _id: dest._id } as never, { $inc: { qtyOnHand: input.qty } } as never, s);
    else await batches(ctx.orgId).insertOne({ ...b, _id: newId(), locationId: input.toLocationId, qtyOnHand: input.qty }, s);
    await addMovement(ctx, { itemId: b.itemId, batchId: b._id, locationId: b.locationId, type: "transfer_out", qty: -input.qty, unitCost: b.unitCost, refType: "transfer", refId: input.toLocationId }, s);
    await addMovement(ctx, { itemId: b.itemId, batchId: b._id, locationId: input.toLocationId, type: "transfer_in", qty: input.qty, unitCost: b.unitCost, refType: "transfer", refId: b.locationId }, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "stock.transfer", resource: "batch", resourceId: b._id, after: input });
  });
}

export async function stockOnHand(ctx: Ctx, itemId: string, now = new Date()): Promise<{ total: number; usable: number }> {
  assertPermission(ctx, "inventory:view");
  const bs = await batches(ctx.orgId).find({ itemId } as never);
  return { total: bs.reduce((a, b) => a + b.qtyOnHand, 0), usable: bs.filter((b) => b.expiry > now).reduce((a, b) => a + b.qtyOnHand, 0) };
}

export async function reorderAlerts(ctx: Ctx) {
  assertPermission(ctx, "inventory:view");
  const all = await items(ctx.orgId).find({ active: true, reorderLevel: { $gt: 0 } } as never);
  const out: { item: Item; onHand: number }[] = [];
  for (const i of all) {
    const bs = await batches(ctx.orgId).find({ itemId: i._id, expiry: { $gt: new Date() } } as never);
    const onHand = bs.reduce((a, b) => a + b.qtyOnHand, 0);
    if (onHand <= i.reorderLevel) out.push({ item: i, onHand });
  }
  return out;
}

export async function nearExpiry(ctx: Ctx, days = 90) {
  assertPermission(ctx, "inventory:view");
  const limit = new Date(Date.now() + days * 86400000);
  return batches(ctx.orgId).find({ qtyOnHand: { $gt: 0 }, expiry: { $lte: limit } } as never, { sort: { expiry: 1 }, limit: 200 });
}

/** Valuation by inventory GL account; must reconcile to the ledger. */
export async function inventoryValuation(ctx: Ctx) {
  assertPermission(ctx, "inventory:view");
  const bs = await batches(ctx.orgId).find({ qtyOnHand: { $gt: 0 } } as never, { limit: 100000 });
  const its = await items(ctx.orgId).find({} as never, { limit: 100000 });
  const sys = new Map(its.map((i) => [i._id, inventoryAccountSystem(i)]));
  const by: Record<string, Decimal> = {};
  for (const b of bs) by[sys.get(b.itemId) ?? "inventory_consumables"] = (by[sys.get(b.itemId) ?? "inventory_consumables"] ?? money(0)).plus(fromDecimal128(b.unitCost).times(b.qtyOnHand));
  return { byAccount: by, total: sum(Object.values(by)) };
}

export async function listItems(ctx: Ctx, f: { category?: Category } = {}) {
  if (!ctx.permissions.includes("inventory:view") && !ctx.permissions.includes("pharmacy:view")) throw new AppError("FORBIDDEN", "Missing permission inventory:view");
  return items(ctx.orgId).find({ active: true, ...(f.category ? { category: f.category } : {}) } as never, { sort: { name: 1 }, limit: 500 });
}
export async function listBatches(ctx: Ctx, itemId?: string) {
  assertPermission(ctx, "inventory:view");
  return batches(ctx.orgId).find({ ...(itemId ? { itemId } : {}), qtyOnHand: { $gt: 0 } } as never, { sort: { expiry: 1 }, limit: 500 });
}
export async function getItem(ctx: Ctx, id: string) {
  if (!["inventory:view", "pharmacy:view", "hospital:view", "emr:update"].some((p) => ctx.permissions.includes(p as never))) throw new AppError("FORBIDDEN", "Missing permission inventory:view");
  return loadItem(ctx.orgId, id);
}
export async function listMovements(ctx: Ctx, itemId: string) {
  assertPermission(ctx, "inventory:view");
  return moves(ctx.orgId).find({ itemId } as never, { sort: { at: -1 }, limit: 200 });
}
