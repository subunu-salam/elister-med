import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { money, fromDecimal128, sum } from "@/core/money";
import { ctxFor } from "@/test/helpers";
import { ensureChartOfAccounts } from "@/modules/ledger/accounts";
import { trialBalance } from "@/modules/reports/trialBalance";
import { createItem, stockOnHand, reorderAlerts, inventoryValuation, adjustStock, listBatches, allocateFefo, receiveIntoStock } from "@/modules/inventory/service";
import { withTransaction } from "@/core/db";
import {
  createSupplier, createReorderRequests, decidePurchaseRequest, createPurchaseOrder, issuePurchaseOrder, receiveGoods, recordSupplierInvoice,
  approveSupplierInvoice, paySupplier, apAging, createPurchaseRequest,
} from "./service";

const ORG = "org-proc";
const im = ctxFor(["inventory_manager"], ORG, "im1", "br1");
const acc = ctxFor(["accountant"], ORG, "acc1", "br1");
const fin = ctxFor(["finance_manager"], ORG, "fin1", "br1");
const future = (days: number) => new Date(Date.now() + days * 86400000);
let supplierId = "", itemId = "";

async function bal(code: string) {
  const tb = await trialBalance(fin, {});
  return tb.rows.find((r) => r.code === code)?.balance ?? money(0);
}

beforeAll(async () => {
  await ensureIndexes();
  await ensureChartOfAccounts(ORG);
  const y = new Date().getUTCFullYear();
  for (const year of [y - 1, y, y + 1]) for (let m = 1; m <= 12; m++)
    await tenantCol<any>(ORG, "fiscal_periods").insertOne({ _id: `${ORG}:${year}-${m}`, year, month: m, status: "open", start: new Date(Date.UTC(year, m - 1, 1, -4)), end: new Date(Date.UTC(year, m, 1, -4)) });
  supplierId = (await createSupplier(acc, { name: "MedSupply LLC", trn: "100000000000003", termsDays: 30 }))._id;
  itemId = (await createItem(im, { sku: "AMOX-500", name: "Amoxicillin 500mg", genericName: "amoxicillin", category: "medicine", reorderLevel: 10, reorderQty: 100, sellingPrice: "25.00" }))._id;
});
afterAll(async () => { await closeClient(); });

async function receive(qty: number, cost: string, batchNo: string, key: string, expiryDays = 400) {
  const po = await createPurchaseOrder(im, { supplierId, lines: [{ itemId, qty, unitCost: cost }] });
  await issuePurchaseOrder(im, po._id);
  const grn = await receiveGoods(im, { poId: po._id, locationId: "pharmacy", idempotencyKey: key, lines: [{ itemId, qty, batchNo, expiry: future(expiryDays) }] });
  return { po, grn };
}

describe("Scenario E: procurement to payment", () => {
  let prId = "", poId = "";

  it("initial stock at cost; inventory valuation equals the GL", async () => {
    await receive(5, "10.00", "B-INIT", "grn-init");
    expect((await stockOnHand(im, itemId)).total).toBe(5);
    const val = await inventoryValuation(im);
    expect((await bal("1200")).toFixed(2)).toBe(val.total.toFixed(2));
  });

  it("reorder threshold creates one draft request; a second run does not duplicate it", async () => {
    expect((await reorderAlerts(im)).map((a) => a.item._id)).toContain(itemId);
    const pr = await createReorderRequests(im);
    expect(pr?.lines).toEqual([{ itemId, qty: 100 }]);
    prId = pr!._id;
    expect(await createReorderRequests(im)).toBeNull();
  });

  it("requester cannot approve own request; a different approver can", async () => {
    await expect(decidePurchaseRequest(im, prId, true)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createPurchaseOrder(im, { supplierId, prId, lines: [{ itemId, qty: 100, unitCost: "10.00" }] })).rejects.toMatchObject({ code: "CONFLICT" });
    await decidePurchaseRequest(fin, prId, true);
    await expect(decidePurchaseRequest(fin, prId, false)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("PO from the approved request; partial then full receipt; no over-receipt; GRN idempotent", async () => {
    const po = await createPurchaseOrder(im, { supplierId, prId, lines: [{ itemId, qty: 100, unitCost: "10.00" }] });
    poId = po._id;
    await expect(receiveGoods(im, { poId, locationId: "pharmacy", idempotencyKey: "g0", lines: [{ itemId, qty: 1, batchNo: "X", expiry: future(300) }] })).rejects.toMatchObject({ code: "CONFLICT" }); // not issued
    await issuePurchaseOrder(im, poId);
    const grn1 = await receiveGoods(im, { poId, locationId: "pharmacy", idempotencyKey: "g1", lines: [{ itemId, qty: 60, batchNo: "B-100", expiry: future(500) }] });
    const again = await receiveGoods(im, { poId, locationId: "pharmacy", idempotencyKey: "g1", lines: [{ itemId, qty: 60, batchNo: "B-100", expiry: future(500) }] });
    expect(again._id).toBe(grn1._id);
    await expect(receiveGoods(im, { poId, locationId: "pharmacy", idempotencyKey: "g2", lines: [{ itemId, qty: 41, batchNo: "B-101", expiry: future(500) }] })).rejects.toMatchObject({ code: "VALIDATION" });
    await receiveGoods(im, { poId, locationId: "pharmacy", idempotencyKey: "g3", lines: [{ itemId, qty: 40, batchNo: "B-101", expiry: future(500) }] });
    expect((await stockOnHand(im, itemId)).total).toBe(105);
    expect((await tenantCol<any>(ORG, "purchase_orders").findOne({ _id: poId })).status).toBe("received");
    expect((await bal("2010")).toFixed(2)).toBe("-1050.00"); // GRNI credit: 50 initial + 1000
  });

  it("supplier invoice: duplicate rejected, recorder cannot approve, approval clears GRNI and creates AP with VAT", async () => {
    const inv = await recordSupplierInvoice(acc, { supplierId, poId, invoiceNo: "INV-MS-1", invoiceDate: new Date(), dueDate: future(30), net: "1000.00", vat: "50.00" });
    await expect(recordSupplierInvoice(acc, { supplierId, poId, invoiceNo: "INV-MS-1", invoiceDate: new Date(), dueDate: future(30), net: "1.00", vat: "0" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(approveSupplierInvoice(acc, inv._id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await bal("2000")).toFixed(2)).toBe("0.00"); // nothing posted before approval
    await approveSupplierInvoice(fin, inv._id);
    expect((await bal("2000")).toFixed(2)).toBe("-1050.00");
    expect((await bal("1600")).toFixed(2)).toBe("50.00");
    expect((await bal("2010")).toFixed(2)).toBe("-50.00"); // only the initial 5 units remain un-invoiced
    await expect(approveSupplierInvoice(fin, inv._id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("price variance goes to its own account", async () => {
    const { po } = await receive(10, "10.00", "B-VAR", "grn-var"); // received value 100.00
    const inv = await recordSupplierInvoice(acc, { supplierId, poId: po._id, invoiceNo: "INV-MS-2", invoiceDate: new Date(), dueDate: future(30), net: "110.00", vat: "5.50" });
    const v0 = await bal("5310");
    await approveSupplierInvoice(fin, inv._id);
    expect((await bal("5310")).minus(v0).toFixed(2)).toBe("10.00");
  });

  it("payments: partial, remainder, idempotent retry, no overpay, finance-only", async () => {
    const list = await tenantCol<any>(ORG, "supplier_invoices").findOne({ invoiceNo: "INV-MS-1" });
    await expect(paySupplier(im, { invoiceId: list._id, amount: "100", method: "bank", idempotencyKey: "p0" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const bank0 = await bal("1010");
    const a = await paySupplier(fin, { invoiceId: list._id, amount: "500.00", method: "bank", idempotencyKey: "p1" });
    const b = await paySupplier(fin, { invoiceId: list._id, amount: "500.00", method: "bank", idempotencyKey: "p1" });
    expect(b._id).toBe(a._id);
    expect((await bal("1010")).minus(bank0).toFixed(2)).toBe("-500.00");
    await expect(paySupplier(fin, { invoiceId: list._id, amount: "600.00", method: "bank", idempotencyKey: "p2" })).rejects.toMatchObject({ code: "VALIDATION" });
    await paySupplier(fin, { invoiceId: list._id, amount: "550.00", method: "bank", idempotencyKey: "p3" });
    expect((await tenantCol<any>(ORG, "supplier_invoices").findOne({ _id: list._id })).status).toBe("paid");
  });

  it("AP sub-ledger equals GL AP; inventory valuation equals GL; books balance", async () => {
    const open = await tenantCol<any>(ORG, "supplier_invoices").find({ status: { $in: ["approved", "partially_paid"] } });
    const sub = sum(open.map((i) => fromDecimal128(i.balance)));
    expect((await bal("2000")).negated().toFixed(2)).toBe(sub.toFixed(2));
    expect((await apAging(fin)).total.toFixed(2)).toBe(sub.toFixed(2));
    expect((await bal("1200")).toFixed(2)).toBe((await inventoryValuation(im)).total.toFixed(2));
    const tb = await trialBalance(fin, {});
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
  });
});

describe("inventory safety", () => {
  it("stock can never go negative; adjustments post to the ledger; wastage must reduce stock", async () => {
    const b = (await listBatches(im, itemId))[0];
    await expect(adjustStock(im, { batchId: b._id, delta: -(b.qtyOnHand + 1), reason: "count" })).rejects.toMatchObject({ code: "VALIDATION" });
    const before = await bal("1200");
    await adjustStock(im, { batchId: b._id, delta: -2, reason: "broken vials", kind: "wastage" });
    expect(before.minus(await bal("1200")).toFixed(2)).toBe("20.00");
    await expect(adjustStock(im, { batchId: b._id, delta: 2, reason: "x", kind: "wastage" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await bal("1200")).toFixed(2)).toBe((await inventoryValuation(im)).total.toFixed(2));
  });

  it("FEFO takes earliest-expiry first and skips expired batches", async () => {
    const sku = await createItem(im, { sku: "FEFO-1", name: "FEFO test", category: "consumable" });
    await withTransaction(async (s) => {
      await receiveIntoStock(im, { itemId: sku._id, locationId: "pharmacy", batchNo: "LATE", expiry: future(400), qty: 5, unitCost: money("1.00"), refType: "t", refId: "t" }, s);
      await receiveIntoStock(im, { itemId: sku._id, locationId: "pharmacy", batchNo: "SOON", expiry: future(30), qty: 5, unitCost: money("2.00"), refType: "t", refId: "t" }, s);
      await receiveIntoStock(im, { itemId: sku._id, locationId: "pharmacy", batchNo: "EXPIRED", expiry: future(-5), qty: 50, unitCost: money("0.50"), refType: "t", refId: "t" }, s);
    });
    const al = await withTransaction((s) => allocateFefo(im, { itemId: sku._id, locationId: "pharmacy", qty: 7, refType: "t", refId: "t2" }, s));
    expect(al.map((a) => [a.batchNo, a.qty])).toEqual([["SOON", 5], ["LATE", 2]]);
    await expect(withTransaction((s) => allocateFefo(im, { itemId: sku._id, locationId: "pharmacy", qty: 4, refType: "t", refId: "t3" }, s))).rejects.toMatchObject({ code: "CONFLICT" }); // only 3 usable left
    expect((await stockOnHand(im, sku._id)).usable).toBe(3);
  });

  it("direct purchase requests need positive whole quantities", async () => {
    await expect(createPurchaseRequest(im, { lines: [{ itemId, qty: 0 }] })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
