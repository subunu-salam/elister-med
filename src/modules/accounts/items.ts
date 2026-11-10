import type { Decimal128 } from "mongodb";
import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { fromDecimal128, money, toDecimal128 } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import type { VatRate } from "@/modules/books/service";

/**
 * Items: the products and services the clinic sells to corporate clients (and buys), Zoho-style. An item carries a default rate,
 * VAT treatment and income/expense accounts so invoice and quote lines can be entered as "SKU | qty" and filled in automatically.
 * Separate from pharmacy/consumable stock (inv_items), which is batch-tracked inventory.
 */
export type CatalogItem = {
  _id: string; sku: string; name: string; kind: "service" | "goods"; unit?: string; description?: string;
  rate: Decimal128; vatRate: VatRate; incomeCode: string; purchaseRate?: Decimal128; expenseCode?: string; active: boolean; createdAt: Date; by: string;
};
const items = (o: string) => tenantCol<CatalogItem>(o, "catalog_items");

const Input = z.object({
  sku: z.string().trim().regex(/^[A-Za-z0-9-]{2,24}$/, "SKU: 2-24 letters, digits or dashes"), name: z.string().trim().min(2, "Name is too short"),
  kind: z.enum(["service", "goods"]).default("service"), unit: z.string().trim().max(12).optional(), description: z.string().trim().max(300).optional(),
  rate: z.string().regex(/^\d+(\.\d{1,2})?$/, "Rate must be a number with at most 2 decimals"), vatRate: z.enum(["STD", "ZERO", "EXEMPT"]).default("STD"),
  incomeCode: z.string().regex(/^4\d{3}$/, "Income account is a 4xxx code").default("4500"),
  purchaseRate: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(), expenseCode: z.string().regex(/^5\d{3}$/, "Expense account is a 5xxx code").optional(),
});

export async function createItem(ctx: Ctx, input: z.input<typeof Input>): Promise<CatalogItem> {
  assertPermission(ctx, "ledger:create");
  const p = Input.safeParse(input);
  if (!p.success) throw new AppError("VALIDATION", p.error.issues[0].message);
  const d = p.data;
  const sku = d.sku.toUpperCase();
  if (await items(ctx.orgId).findOne({ sku } as never)) throw new AppError("CONFLICT", `Item ${sku} already exists`);
  const codes = [d.incomeCode, ...(d.expenseCode ? [d.expenseCode] : [])];
  const accs = await tenantCol<{ code: string; active: boolean }>(ctx.orgId, "accounts").find({ code: { $in: codes } } as never);
  for (const c of codes) if (!accs.find((a) => a.code === c && a.active)) throw new AppError("VALIDATION", `Account ${c} does not exist or is inactive`);
  const it: CatalogItem = {
    _id: newId(), sku, name: d.name, kind: d.kind, unit: d.unit || undefined, description: d.description || undefined, rate: toDecimal128(money(d.rate)), vatRate: d.vatRate, incomeCode: d.incomeCode,
    purchaseRate: d.purchaseRate ? toDecimal128(money(d.purchaseRate)) : undefined, expenseCode: d.expenseCode, active: true, createdAt: new Date(), by: ctx.userId,
  };
  await withTransaction(async (s) => {
    await items(ctx.orgId).insertOne(it, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "item.create", resource: "catalog_item", resourceId: it._id, after: { sku, name: it.name, rate: d.rate } });
  });
  return it;
}

export async function updateItemRate(ctx: Ctx, id: string, rate: string): Promise<void> {
  assertPermission(ctx, "ledger:create");
  if (!/^\d+(\.\d{1,2})?$/.test(rate)) throw new AppError("VALIDATION", "Rate must be a number with at most 2 decimals");
  const r = await items(ctx.orgId).updateOne({ _id: id } as never, { $set: { rate: toDecimal128(money(rate)) } } as never);
  if (!r.matchedCount) throw new AppError("NOT_FOUND", "Item not found");
}

export async function setItemActive(ctx: Ctx, id: string, active: boolean): Promise<void> {
  assertPermission(ctx, "ledger:create");
  const r = await items(ctx.orgId).updateOne({ _id: id } as never, { $set: { active } } as never);
  if (!r.matchedCount) throw new AppError("NOT_FOUND", "Item not found");
}

export async function listItems(ctx: Ctx, opts: { activeOnly?: boolean } = {}) {
  assertPermission(ctx, "ledger:view");
  return items(ctx.orgId).find((opts.activeOnly ? { active: true } : {}) as never, { sort: { name: 1 }, limit: 1000 });
}

/**
 * Lets line text reference items. A row starting with "@SKU" becomes "Item name | qty | rate | VAT | income account"; the qty can follow
 * ("@MED-01 | 40") and a price override after that ("@MED-01 | 40 | 165"). Rows without "@" pass through untouched for parseLines().
 */
export async function expandItemLines(ctx: Ctx, text: string, use: "sale" | "purchase" = "sale"): Promise<string> {
  if (!text.includes("@")) return text;
  const cat = new Map((await listItems(ctx, { activeOnly: true })).map((i) => [i.sku, i]));
  return text.split("\n").map((row) => {
    const t = row.trim();
    if (!t.startsWith("@")) return row;
    const [ref, qty, price] = t.slice(1).split("|").map((x) => x.trim());
    const it = cat.get((ref ?? "").toUpperCase());
    if (!it) throw new AppError("VALIDATION", `No active item with SKU ${ref}`);
    const rate = price || fromDecimal128(use === "purchase" ? it.purchaseRate ?? it.rate : it.rate).toFixed(2);
    const acct = use === "purchase" ? it.expenseCode ?? "5800" : it.incomeCode;
    return `${it.name} | ${qty || "1"} | ${rate} | ${it.vatRate} | ${acct}`;
  }).join("\n");
}
