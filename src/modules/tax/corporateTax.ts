import Decimal from "decimal.js";
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
import { trialBalance } from "@/modules/reports/trialBalance";

/**
 * UAE Corporate Tax (Federal Decree-Law No. 47 of 2022), shaped for a clinic that is a mainland taxable person.
 * The statutory parameters below are named constants so a change in law is a one-line edit. Nothing here files with the FTA:
 * it prepares the computation, books the provision and payment, and records the return reference.
 *
 *  - 0% on taxable income up to AED 375,000, 9% above it.
 *  - Taxable income starts from accounting profit (IFRS), then add-backs (e.g. 50% of client entertainment, fines) and deductions.
 *  - Tax losses carry forward without time limit but may offset only 75% of taxable income in a later year.
 *  - Small Business Relief (elective): revenue <= AED 3m in the period and the prior period, tax periods ending on or before 31 Dec 2026.
 *    While relief is used the taxable person is treated as having no taxable income and no losses are carried forward.
 *  - Return and payment are due within 9 months of the period end.
 * Healthcare income is taxable; there is no general healthcare exemption. Qualifying Free Zone status, group relief, transfer pricing and
 * the interest-limitation rule are NOT modelled and need a tax adviser.
 */
export const CT = {
  rate: 9, zeroBand: 375_000, lossOffsetCap: 0.75, sbrRevenueLimit: 3_000_000, sbrLastPeriodEnd: "2026-12-31", dueMonths: 9,
  regime: "UAE Corporate Tax (Federal Decree-Law No. 47 of 2022)",
} as const;

export type TreatmentCode = "deductible" | "entertainment_50" | "non_deductible";
/** Share of an expense that is NOT deductible, by treatment. */
export const NON_DEDUCTIBLE_PCT: Record<TreatmentCode, number> = { deductible: 0, entertainment_50: 50, non_deductible: 100 };

export type TaxConfig = { trn?: string; registered: boolean; sbrElected: boolean; firstYear?: number; lossesBroughtForward: string; notes?: string };
export type TaxAdjustment = { _id: string; year: number; kind: "add_back" | "deduct"; label: string; amount: Decimal128; note?: string; by: string; at: Date };
export type TaxReturnDoc = { _id: string; year: number; provisionBooked: Decimal128; paid: Decimal128; status: "open" | "filed"; filedAt?: Date; reference?: string; filedBy?: string; snapshot?: Record<string, unknown> };

const cfgCol = (o: string) => tenantCol<TaxConfig & { key: string }>(o, "tax_config");
const adjCol = (o: string) => tenantCol<TaxAdjustment>(o, "tax_adjustments");
const retCol = (o: string) => tenantCol<TaxReturnDoc>(o, "tax_returns");
const v = <T>(r: { success: true; data: T } | { success: false; error: { message: string } }): T => { if (!r.success) throw new AppError("VALIDATION", r.error.message); return r.data; };
const amt = z.string().regex(/^\d+(\.\d{1,2})?$/, "Amount must be a positive number with at most 2 decimals");
const dubai = (ymd: string) => new Date(`${ymd}T00:00:00+04:00`);

export async function ensureTaxAccounts(orgId: string): Promise<void> {
  const col = tenantCol(orgId, "accounts");
  const defs = [
    { code: "2150", name: "Corporate Tax Payable", type: "liability", normal: "credit", system: "ct_payable" },
    { code: "5960", name: "Corporate Tax Expense", type: "expense", normal: "debit", system: "ct_expense" },
  ];
  for (const a of defs) await col.updateOne({ code: a.code } as never, { $setOnInsert: { _id: `${orgId}:${a.code}`, ...a, active: true } } as never, undefined, { upsert: true });
}

export async function getTaxConfig(ctx: Ctx): Promise<TaxConfig> {
  assertPermission(ctx, "ledger:view");
  const c = await cfgCol(ctx.orgId).findOne({ key: "ct" } as never);
  return { registered: c?.registered ?? false, sbrElected: c?.sbrElected ?? false, trn: c?.trn, firstYear: c?.firstYear, lossesBroughtForward: c?.lossesBroughtForward ?? "0.00", notes: c?.notes };
}
export async function setTaxConfig(ctx: Ctx, input: { trn?: string; registered: boolean; sbrElected: boolean; firstYear?: number; lossesBroughtForward?: string; notes?: string }): Promise<void> {
  assertPermission(ctx, "ledger:approve");
  const d = v(z.object({ trn: z.string().regex(/^\d{15}$/, "A tax registration number has 15 digits").optional(), registered: z.boolean(), sbrElected: z.boolean(), firstYear: z.number().int().min(2023).max(2100).optional(), lossesBroughtForward: amt.default("0.00"), notes: z.string().optional() }).safeParse(input));
  await withTransaction(async (s) => {
    await cfgCol(ctx.orgId).updateOne({ key: "ct" } as never, { $set: { key: "ct", ...d } } as never, s, { upsert: true });
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "tax.config", resource: "tax_config", resourceId: "ct", after: d });
  });
}

export async function addTaxAdjustment(ctx: Ctx, input: { year: number; kind: "add_back" | "deduct"; label: string; amount: string; note?: string }): Promise<TaxAdjustment> {
  assertPermission(ctx, "ledger:create");
  const d = v(z.object({ year: z.number().int().min(2023).max(2100), kind: z.enum(["add_back", "deduct"]), label: z.string().min(3), amount: amt, note: z.string().optional() }).safeParse(input));
  if (money(d.amount).lte(0)) throw new AppError("VALIDATION", "Amount must be greater than zero");
  await assertNotFiled(ctx.orgId, d.year);
  const a: TaxAdjustment = { _id: newId(), year: d.year, kind: d.kind, label: d.label, amount: toDecimal128(money(d.amount)), note: d.note, by: ctx.userId, at: new Date() };
  await withTransaction(async (s) => { await adjCol(ctx.orgId).insertOne(a, s); await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "tax.adjustment_add", resource: "tax_adjustment", resourceId: a._id, after: { year: d.year, kind: d.kind, amount: d.amount, label: d.label } }); });
  return a;
}
export async function removeTaxAdjustment(ctx: Ctx, id: string): Promise<void> {
  assertPermission(ctx, "ledger:approve");
  const a = await adjCol(ctx.orgId).findOne({ _id: id } as never);
  if (!a) throw new AppError("NOT_FOUND", "Adjustment not found");
  await assertNotFiled(ctx.orgId, a.year);
  await withTransaction(async (s) => {
    await tenantCol(ctx.orgId, "tax_adjustments").updateOne({ _id: id } as never, { $set: { removed: true, removedBy: ctx.userId } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "tax.adjustment_remove", resource: "tax_adjustment", resourceId: id });
  });
}
async function assertNotFiled(orgId: string, year: number) {
  const r = await retCol(orgId).findOne({ year } as never);
  if (r?.status === "filed") throw new AppError("CONFLICT", `The ${year} return is already filed. Amend it with the FTA first; nothing can change here.`);
}

export type CtLine = { label: string; amount: Decimal; source: "ledger" | "expense" | "manual" };
export type CtComputation = {
  year: number; from: Date; to: Date; accountingProfit: Decimal; revenue: Decimal; addBacks: CtLine[]; deductions: CtLine[];
  taxableBeforeLoss: Decimal; lossBroughtForward: Decimal; lossUsed: Decimal; lossCarriedForward: Decimal; taxableIncome: Decimal;
  sbrEligible: boolean; sbrApplied: boolean; tax: Decimal; effectiveRate: Decimal; dueDate: Date; provisionBooked: Decimal; paid: Decimal; payable: Decimal; status: "open" | "filed";
  reference?: string; notes: string[];
};

/** Accounting profit before corporate tax, and revenue, from the ledger for a Dubai-time date range. */
async function ledgerProfit(ctx: Ctx, from: Date, to: Date) {
  const tb = await trialBalance(ctx, { from, to });
  let income = money(0), expense = money(0);
  for (const r of tb.rows) {
    if (r.code === "5960") continue;
    if (r.type === "income") income = income.plus(r.credit).minus(r.debit);
    else if (r.type === "expense") expense = expense.plus(r.debit).minus(r.credit);
  }
  return { profit: income.minus(expense), revenue: income };
}

/** Add-backs from tagged expense documents (entertainment 50%, non-deductible items). Entertainment VAT that cannot be recovered is part of the expense. */
async function expenseAddBacks(ctx: Ctx, from: Date, to: Date): Promise<CtLine[]> {
  const rows = await tenantCol<{ date: Date; treatment: TreatmentCode; net: Decimal128; irrecoverableVat: Decimal128; category: string; reversed?: boolean }>(ctx.orgId, "expenses").find({ date: { $gte: from, $lt: to }, treatment: { $in: ["entertainment_50", "non_deductible"] }, reversed: { $ne: true } } as never, { limit: 100000 });
  const by = new Map<string, Decimal>();
  for (const e of rows) {
    const base = fromDecimal128(e.net).plus(fromDecimal128(e.irrecoverableVat));
    const add = round2(base.times(NON_DEDUCTIBLE_PCT[e.treatment]).div(100));
    const label = e.treatment === "entertainment_50" ? "Client entertainment: 50% not deductible" : "Non-deductible expenses (fines, penalties, personal items)";
    by.set(label, (by.get(label) ?? money(0)).plus(add));
  }
  return [...by].map(([label, amount]) => ({ label, amount, source: "expense" as const }));
}

export async function computeCorporateTax(ctx: Ctx, year: number): Promise<CtComputation> {
  assertPermission(ctx, "ledger:view");
  const cfg = await getTaxConfig(ctx);
  const firstYear = cfg.firstYear ?? year;
  if (year < firstYear) throw new AppError("VALIDATION", `Corporate tax starts with ${firstYear} for this entity`);
  let pool = money(cfg.lossesBroughtForward);
  let prevRevenue: Decimal | null = null;
  let out!: CtComputation;
  for (let y = firstYear; y <= year; y++) {
    const from = dubai(`${y}-01-01`), to = dubai(`${y + 1}-01-01`);
    const { profit, revenue } = await ledgerProfit(ctx, from, to);
    const manual = (await adjCol(ctx.orgId).find({ year: y, removed: { $ne: true } } as never)) as (TaxAdjustment & { removed?: boolean })[];
    const addBacks: CtLine[] = [...(await expenseAddBacks(ctx, from, to)), ...manual.filter((a) => a.kind === "add_back").map((a) => ({ label: a.label, amount: fromDecimal128(a.amount), source: "manual" as const }))];
    const deductions: CtLine[] = manual.filter((a) => a.kind === "deduct").map((a) => ({ label: a.label, amount: fromDecimal128(a.amount), source: "manual" as const }));
    const before = profit.plus(sum(addBacks.map((l) => l.amount))).minus(sum(deductions.map((l) => l.amount)));
    const lossBF = pool;
    const notes: string[] = [];
    const periodEndOk = `${y}-12-31` <= CT.sbrLastPeriodEnd;
    const sbrEligible = periodEndOk && revenue.lte(CT.sbrRevenueLimit) && (prevRevenue === null || prevRevenue.lte(CT.sbrRevenueLimit));
    const sbrApplied = cfg.sbrElected && sbrEligible;
    let lossUsed = money(0), taxable = money(0), lossCF = lossBF, tax = money(0);
    if (sbrApplied) {
      notes.push("Small Business Relief applied: no taxable income, and no tax loss is created or carried forward for this period.");
    } else if (before.isNegative()) {
      lossCF = lossBF.plus(before.abs());
      notes.push("Tax loss for the period is added to the loss pool.");
    } else {
      lossUsed = Decimal.min(lossBF, before.times(CT.lossOffsetCap));
      taxable = before.minus(lossUsed);
      lossCF = lossBF.minus(lossUsed);
      tax = round2(Decimal.max(0, taxable.minus(CT.zeroBand)).times(CT.rate).div(100));
      if (lossBF.gt(0) && lossUsed.lt(lossBF)) notes.push("Loss relief is capped at 75% of taxable income; the rest stays in the pool.");
    }
    if (!sbrApplied && sbrEligible) notes.push("Eligible for Small Business Relief (revenue within AED 3m) but not elected. Electing gives up loss carry-forward.");
    if (!sbrEligible && cfg.sbrElected) notes.push("Small Business Relief is not available for this period (revenue above AED 3m, or period ends after 31 Dec 2026).");
    pool = sbrApplied ? lossBF : lossCF;
    prevRevenue = revenue;
    if (y === year) {
      const ret = await retCol(ctx.orgId).findOne({ year } as never);
      const booked = fromDecimal128(ret?.provisionBooked), paid = fromDecimal128(ret?.paid);
      const due = new Date(Date.UTC(y + 1, CT.dueMonths, 0, 0) - 4 * 3600_000 + 86400_000 - 1);
      out = { year, from, to, accountingProfit: profit, revenue, addBacks, deductions, taxableBeforeLoss: before, lossBroughtForward: lossBF, lossUsed, lossCarriedForward: pool, taxableIncome: taxable, sbrEligible, sbrApplied, tax, effectiveRate: before.gt(0) ? tax.div(before).times(100) : money(0), dueDate: due, provisionBooked: booked, paid, payable: booked.minus(paid), status: ret?.status ?? "open", reference: ret?.reference, notes };
    }
  }
  return out;
}

/** Books (or adjusts) the provision: Dr Corporate tax expense / Cr Corporate tax payable, for the difference to what is already booked. Idempotent per revision. */
export async function provisionCorporateTax(ctx: Ctx, year: number): Promise<{ delta: Decimal; booked: Decimal }> {
  assertPermission(ctx, "ledger:create");
  await ensureTaxAccounts(ctx.orgId);
  await assertNotFiled(ctx.orgId, year);
  const c = await computeCorporateTax(ctx, year);
  const delta = c.tax.minus(c.provisionBooked);
  if (delta.isZero()) return { delta, booked: c.provisionBooked };
  return withTransaction(async (s) => {
    const rev = await nextSeq(ctx.orgId, `ct-prov:${year}`, s);
    const exp = (await accountBySystem(ctx.orgId, "ct_expense"))._id, pay = (await accountBySystem(ctx.orgId, "ct_payable"))._id;
    const up = delta.gt(0);
    await postJournalSystem(ctx, {
      date: new Date(), memo: `Corporate tax provision ${year}${up ? "" : " (adjustment)"}`, sourceRef: { type: "corporate_tax", id: `${year}:${rev}` }, idempotencyKey: `ct-prov:${year}:${rev}`,
      lines: [{ accountId: up ? exp : pay, debit: delta.abs().toFixed(2) }, { accountId: up ? pay : exp, credit: delta.abs().toFixed(2) }],
    }, s);
    const booked = c.provisionBooked.plus(delta);
    await retCol(ctx.orgId).updateOne({ year } as never, { $set: { year, provisionBooked: toDecimal128(booked) }, $setOnInsert: { _id: `${ctx.orgId}:ct:${year}`, paid: toDecimal128(money(0)), status: "open" } } as never, s, { upsert: true });
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "tax.provision", resource: "tax_return", resourceId: String(year), after: { delta: delta.toFixed(2), booked: booked.toFixed(2) } });
    return { delta, booked };
  });
}

export async function payCorporateTax(ctx: Ctx, input: { year: number; amount: string; method?: "bank" | "cash"; idempotencyKey: string }): Promise<void> {
  assertPermission(ctx, "ledger:create");
  const d = v(z.object({ year: z.number().int(), amount: amt, method: z.enum(["bank", "cash"]).default("bank"), idempotencyKey: z.string().min(1) }).safeParse(input));
  const prior = await tenantCol(ctx.orgId, "journal_entries").findOne({ idempotencyKey: `ct-pay:${d.idempotencyKey}` } as never);
  if (prior) return;
  await ensureTaxAccounts(ctx.orgId);
  await withTransaction(async (s) => {
    const ret = await retCol(ctx.orgId).findOne({ year: d.year } as never, s);
    const payable = fromDecimal128(ret?.provisionBooked).minus(fromDecimal128(ret?.paid));
    const a = money(d.amount);
    if (a.lte(0)) throw new AppError("VALIDATION", "Amount must be greater than zero");
    if (a.gt(payable)) throw new AppError("VALIDATION", `Payment exceeds the corporate tax payable for ${d.year} (${payable.toFixed(2)})`);
    await postJournalSystem(ctx, {
      date: new Date(), memo: `Corporate tax payment ${d.year} to FTA`, sourceRef: { type: "corporate_tax_payment", id: d.idempotencyKey }, idempotencyKey: `ct-pay:${d.idempotencyKey}`,
      lines: [{ accountId: (await accountBySystem(ctx.orgId, "ct_payable"))._id, debit: a.toFixed(2) }, { accountId: (await accountBySystem(ctx.orgId, d.method))._id, credit: a.toFixed(2) }],
    }, s);
    await retCol(ctx.orgId).updateOne({ year: d.year } as never, { $set: { paid: toDecimal128(fromDecimal128(ret?.paid).plus(a)) } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "tax.payment", resource: "tax_return", resourceId: String(d.year), after: { amount: a.toFixed(2) } });
  });
}

/** Records that the return was submitted to the FTA (EmaraTax). Needs the provision to match the computation. Locks the year's adjustments. */
export async function markReturnFiled(ctx: Ctx, input: { year: number; reference: string }): Promise<void> {
  assertPermission(ctx, "ledger:approve");
  if (!input.reference.trim()) throw new AppError("VALIDATION", "Enter the FTA submission reference");
  const c = await computeCorporateTax(ctx, input.year);
  if (!c.tax.equals(c.provisionBooked)) throw new AppError("CONFLICT", `The booked provision (${c.provisionBooked.toFixed(2)}) differs from the computed tax (${c.tax.toFixed(2)}). Book the provision first.`);
  await withTransaction(async (s) => {
    await retCol(ctx.orgId).updateOne({ year: input.year } as never, { $set: { year: input.year, status: "filed", filedAt: new Date(), filedBy: ctx.userId, reference: input.reference, snapshot: { taxable: c.taxableIncome.toFixed(2), tax: c.tax.toFixed(2), lossCF: c.lossCarriedForward.toFixed(2) } }, $setOnInsert: { _id: `${ctx.orgId}:ct:${input.year}`, provisionBooked: toDecimal128(money(0)), paid: toDecimal128(money(0)) } } as never, s, { upsert: true });
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "tax.return_filed", resource: "tax_return", resourceId: String(input.year), after: { reference: input.reference } });
  });
}

export async function listTaxAdjustments(ctx: Ctx, year: number) {
  assertPermission(ctx, "ledger:view");
  return (await adjCol(ctx.orgId).find({ year, removed: { $ne: true } } as never, { sort: { at: 1 } })) as TaxAdjustment[];
}

/** Deadlines worth showing on the page. */
export function ctCalendar(year: number) {
  return [
    { label: `Return and payment for FY${year}`, due: `${year + 1}-09-30` },
    { label: "Register for corporate tax (late registration penalty AED 10,000)", due: "Within the FTA deadline for your licence date" },
    { label: "Keep records for 7 years after the end of the tax period", due: "Ongoing" },
  ];
}
