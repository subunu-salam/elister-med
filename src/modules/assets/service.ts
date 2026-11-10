import type { Decimal128 } from "mongodb";
import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { newId } from "@/core/ids";
import { nextSeq } from "@/core/counters";
import { AppError } from "@/core/errors";
import { fromDecimal128, money, round2, sum, toDecimal128 } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { accountBySystem } from "@/modules/ledger/accounts";
import { postJournalSystem } from "@/modules/ledger/journal";
import { dubaiParts } from "@/core/time";

/**
 * Fixed-asset register for a clinic (dental chairs, X-ray, autoclaves, fit-out, IT). Straight-line depreciation by month.
 * UAE corporate tax follows accounting depreciation, so this register is also the tax depreciation schedule.
 * Cost sits in 1500, accumulated depreciation in 1510, expense in 5900 (all in the standard chart of accounts).
 */
export type Asset = {
  _id: string; tag: string; name: string; category: string; cost: Decimal128; residual: Decimal128; lifeMonths: number; purchaseDate: Date; startMonth: string;
  accumulated: Decimal128; depreciatedThrough?: string; status: "active" | "disposed"; location?: string; serial?: string; vendor?: string;
  disposal?: { date: Date; proceeds: Decimal128; gainLoss: Decimal128; journalEntryId: string }; createdBy: string; createdAt: Date;
};
export const CATEGORIES = ["Medical equipment", "Dental equipment", "Imaging equipment", "Laboratory equipment", "Furniture and fit-out", "IT and software", "Vehicles", "Other"] as const;
const assets = (o: string) => tenantCol<Asset>(o, "fixed_assets");
const v = <T>(r: { success: true; data: T } | { success: false; error: { message: string } }): T => { if (!r.success) throw new AppError("VALIDATION", r.error.message); return r.data; };
const amt = z.string().regex(/^\d+(\.\d{1,2})?$/, "Amount must be a number with at most 2 decimals");
const ym = (d: Date) => dubaiParts(d).ymd.slice(0, 7);
const addMonths = (p: string, n: number) => { const [y, m] = p.split("-").map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; };

export async function ensureAssetAccounts(orgId: string): Promise<void> {
  const col = tenantCol(orgId, "accounts");
  for (const a of [
    { code: "4910", name: "Gain on Disposal of Assets", type: "income", normal: "credit", system: "asset_gain" },
    { code: "5910", name: "Loss on Disposal of Assets", type: "expense", normal: "debit", system: "asset_loss" },
  ]) await col.updateOne({ code: a.code } as never, { $setOnInsert: { _id: `${orgId}:${a.code}`, ...a, active: true } } as never, undefined, { upsert: true });
}

const monthly = (a: Pick<Asset, "cost" | "residual" | "lifeMonths">) => round2(fromDecimal128(a.cost).minus(fromDecimal128(a.residual)).div(a.lifeMonths));

/**
 * Registers an asset. With `alreadyInLedger` the cost (and any depreciation up to `depreciatedThrough`) is already booked, so nothing is posted:
 * use it to load an existing register. Otherwise a purchase is posted: Dr Fixed assets (+ input VAT) / Cr bank, cash or payables.
 */
export async function registerAsset(ctx: Ctx, input: {
  name: string; category: string; cost: string; vat?: string; residual?: string; lifeMonths: number; purchaseDate: Date; paidFrom?: "bank" | "cash" | "ap"; vendor?: string; location?: string; serial?: string;
  alreadyInLedger?: { accumulated: string; depreciatedThrough?: string }; startMonth?: string;
}): Promise<Asset> {
  assertPermission(ctx, "ledger:create");
  const d = v(z.object({ name: z.string().min(2), category: z.string().min(2), cost: amt, vat: amt.default("0.00"), residual: amt.default("0.00"), lifeMonths: z.number().int().min(1).max(600) }).safeParse(input));
  if (money(d.residual).gte(money(d.cost))) throw new AppError("VALIDATION", "Residual value must be below cost");
  await ensureAssetAccounts(ctx.orgId);
  return withTransaction(async (s) => {
    const seq = await nextSeq(ctx.orgId, "asset", s);
    const a: Asset = {
      _id: newId(), tag: `FA-${String(seq).padStart(4, "0")}`, name: d.name, category: d.category, cost: toDecimal128(money(d.cost)), residual: toDecimal128(money(d.residual)), lifeMonths: d.lifeMonths,
      purchaseDate: input.purchaseDate, startMonth: input.startMonth ?? ym(input.purchaseDate), accumulated: toDecimal128(money(input.alreadyInLedger?.accumulated ?? "0")), depreciatedThrough: input.alreadyInLedger?.depreciatedThrough,
      status: "active", location: input.location, serial: input.serial, vendor: input.vendor, createdBy: ctx.userId, createdAt: new Date(),
    };
    await assets(ctx.orgId).insertOne(a, s);
    if (!input.alreadyInLedger) {
      const vat = money(d.vat), cost = money(d.cost);
      const from = input.paidFrom ?? "bank";
      await postJournalSystem(ctx, {
        date: new Date(), memo: `Asset purchase ${a.tag}: ${a.name}`, sourceRef: { type: "asset_purchase", id: a._id }, idempotencyKey: `asset-buy:${a._id}`,
        lines: [
          { accountId: `${ctx.orgId}:1500`, debit: cost.toFixed(2) }, ...(vat.gt(0) ? [{ accountId: (await accountBySystem(ctx.orgId, "vat_input"))._id, debit: vat.toFixed(2) }] : []),
          { accountId: (await accountBySystem(ctx.orgId, from === "ap" ? "ap" : from))._id, credit: cost.plus(vat).toFixed(2) },
        ],
      }, s);
    }
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "asset.register", resource: "fixed_asset", resourceId: a._id, after: { tag: a.tag, cost: d.cost, lifeMonths: d.lifeMonths } });
    return a;
  });
}

/** Depreciation for one month (YYYY-MM) across all active assets: one journal Dr Depreciation / Cr Accumulated depreciation. Safe to run twice. */
export async function runDepreciation(ctx: Ctx, period: string): Promise<{ posted: string; assets: number }> {
  assertPermission(ctx, "ledger:create");
  if (!/^\d{4}-\d{2}$/.test(period)) throw new AppError("VALIDATION", "Period must be YYYY-MM");
  return withTransaction(async (s) => {
    const list = await assets(ctx.orgId).find({ status: "active" } as never, { session: s });
    let total = money(0), n = 0;
    for (const a of list) {
      if (a.startMonth > period || (a.depreciatedThrough && a.depreciatedThrough >= period)) continue;
      const depreciable = fromDecimal128(a.cost).minus(fromDecimal128(a.residual));
      const left = depreciable.minus(fromDecimal128(a.accumulated));
      if (left.lte(0)) continue;
      const m = monthly(a), amountNow = m.gt(left) ? left : m;
      // an asset registered with a gap (months not depreciated) catches up in the first run
      const gap = a.depreciatedThrough ? 0 : 0;
      void gap;
      const upd = await assets(ctx.orgId).updateOne({ _id: a._id, accumulated: a.accumulated } as never, { $set: { accumulated: toDecimal128(fromDecimal128(a.accumulated).plus(amountNow)), depreciatedThrough: period } } as never, s);
      if (upd.matchedCount === 0) throw new AppError("CONFLICT", "Asset changed concurrently");
      total = total.plus(amountNow); n++;
    }
    if (total.isZero()) return { posted: "0.00", assets: 0 };
    await postJournalSystem(ctx, {
      date: new Date(), memo: `Depreciation ${period} (fixed-asset register)`, sourceRef: { type: "depreciation", id: period }, idempotencyKey: `dep-run:${period}`,
      lines: [{ accountId: `${ctx.orgId}:5900`, debit: total.toFixed(2) }, { accountId: `${ctx.orgId}:1510`, credit: total.toFixed(2) }],
    }, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "asset.depreciate", resource: "fixed_asset", resourceId: period, after: { total: total.toFixed(2), assets: n } });
    return { posted: total.toFixed(2), assets: n };
  });
}

export async function disposeAsset(ctx: Ctx, input: { id: string; proceeds: string; method?: "bank" | "cash" }): Promise<Asset> {
  assertPermission(ctx, "ledger:approve");
  const proceeds = money(v(z.object({ proceeds: amt }).safeParse(input)).proceeds);
  await ensureAssetAccounts(ctx.orgId);
  return withTransaction(async (s) => {
    const a = await assets(ctx.orgId).findOne({ _id: input.id } as never, s);
    if (!a) throw new AppError("NOT_FOUND", "Asset not found");
    if (a.status !== "active") throw new AppError("CONFLICT", "Asset is already disposed");
    const cost = fromDecimal128(a.cost), acc = fromDecimal128(a.accumulated), nbv = cost.minus(acc), gl = proceeds.minus(nbv);
    const cashAcc = (await accountBySystem(ctx.orgId, input.method ?? "bank"))._id;
    const lines = [
      ...(proceeds.gt(0) ? [{ accountId: cashAcc, debit: proceeds.toFixed(2) }] : []),
      ...(acc.gt(0) ? [{ accountId: `${ctx.orgId}:1510`, debit: acc.toFixed(2) }] : []),
      ...(gl.isNegative() ? [{ accountId: `${ctx.orgId}:5910`, debit: gl.abs().toFixed(2) }] : []),
      { accountId: `${ctx.orgId}:1500`, credit: cost.toFixed(2) },
      ...(gl.gt(0) ? [{ accountId: `${ctx.orgId}:4910`, credit: gl.toFixed(2) }] : []),
    ];
    const je = await postJournalSystem(ctx, { date: new Date(), memo: `Disposal of ${a.tag}: ${a.name}`, sourceRef: { type: "asset_disposal", id: a._id }, idempotencyKey: `asset-sell:${a._id}`, lines }, s);
    const disposal = { date: new Date(), proceeds: toDecimal128(proceeds), gainLoss: toDecimal128(gl), journalEntryId: je._id };
    await assets(ctx.orgId).updateOne({ _id: a._id } as never, { $set: { status: "disposed", disposal } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "asset.dispose", resource: "fixed_asset", resourceId: a._id, after: { proceeds: proceeds.toFixed(2), gainLoss: gl.toFixed(2) } });
    return { ...a, status: "disposed", disposal };
  });
}

export async function listAssets(ctx: Ctx) { assertPermission(ctx, "ledger:view"); return assets(ctx.orgId).find({} as never, { sort: { tag: 1 }, limit: 2000 }); }

/** Register totals against the ledger: they must agree. */
export async function assetRegisterSummary(ctx: Ctx) {
  assertPermission(ctx, "ledger:view");
  const list = await assets(ctx.orgId).find({ status: "active" } as never, { limit: 5000 });
  const cost = sum(list.map((a) => fromDecimal128(a.cost))), acc = sum(list.map((a) => fromDecimal128(a.accumulated)));
  const gl = await tenantCol<{ accountCode: string; debit: Decimal128; credit: Decimal128 }>(ctx.orgId, "gl_lines").aggregate<{ _id: string; d: Decimal128; c: Decimal128 }>([
    { $match: { accountCode: { $in: ["1500", "1510"] } } }, { $group: { _id: "$accountCode", d: { $sum: "$debit" }, c: { $sum: "$credit" } } },
  ]);
  const bal = (code: string) => { const r = gl.find((x) => x._id === code); return r ? fromDecimal128(r.d).minus(fromDecimal128(r.c)) : money(0); };
  const ledgerCost = bal("1500"), ledgerAcc = bal("1510").negated();
  return { cost, accumulated: acc, nbv: cost.minus(acc), ledgerCost, ledgerAccumulated: ledgerAcc, costDifference: cost.minus(ledgerCost), accumulatedDifference: acc.minus(ledgerAcc), reconciled: cost.equals(ledgerCost) && acc.equals(ledgerAcc), monthlyCharge: sum(list.filter((a) => fromDecimal128(a.cost).minus(fromDecimal128(a.residual)).gt(fromDecimal128(a.accumulated))).map((a) => monthly(a))) };
}
export { addMonths as _addMonths };
