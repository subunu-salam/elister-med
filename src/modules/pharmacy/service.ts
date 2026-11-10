import type { ClientSession, Decimal128 } from "mongodb";
import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { emit } from "@/core/outbox";
import { nextSeq } from "@/core/counters";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { fromDecimal128, money, sum, toDecimal128 } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { accountBySystem } from "@/modules/ledger/accounts";
import { postJournalSystem } from "@/modules/ledger/journal";
import { docNo, yearOf } from "@/modules/billing/invoice";
import { createItemCharge, reduceItemCharge } from "@/modules/billing/charges";
import { getEncounterBrief } from "@/modules/emr/service";
import { getPatient } from "@/modules/patients/service";
import { allocateFefo, allocationValue, getItem, inventoryAccountSystem, listItems, nearExpiry, reorderAlerts, returnToBatch, type Allocation, type Item } from "@/modules/inventory/service";

export type RxStatus = "draft" | "signed" | "verified" | "partially_dispensed" | "dispensed" | "cancelled";
export type RxLine = { itemId: string; name: string; dose: string; frequency: string; durationDays: number; qty: number; instructions?: string; substitutionAllowed: boolean; dispensed: number };
export type RxAlert = { type: "allergy" | "duplicate" | "interaction_not_checked"; message: string; blocking: boolean };
export type Prescription = {
  _id: string; number: string; encounterId: string; patientId: string; doctorId: string; status: RxStatus; lines: RxLine[]; alerts: RxAlert[];
  overrideReason?: string; createdBy: string; signedAt?: Date; verifiedBy?: string; verifiedAt?: Date; refillOf?: string; createdAt: Date;
};
export type DispenseLine = { itemId: string; dispensedItemId: string; name: string; qty: number; returned: number; allocations: Allocation[]; substitute: boolean; cogs: Decimal128 };
export type Dispensing = { _id: string; prescriptionId: string; encounterId: string; patientId: string; lines: DispenseLine[]; idempotencyKey: string; at: Date; by: string; journalEntryId: string };

const rxs = (o: string) => tenantCol<Prescription>(o, "prescriptions");
const disp = (o: string) => tenantCol<Dispensing>(o, "dispensings");
const INTERACTION_NOTE = "Drug-interaction checking is NOT performed: no licensed drug-knowledge source is connected.";

const LineInput = z.object({
  itemId: z.string(), dose: z.string().min(1), frequency: z.string().min(1), durationDays: z.number().int().positive().max(365),
  qty: z.number().int().positive().max(1000), instructions: z.string().optional(), substitutionAllowed: z.boolean().default(false),
});

/** Allergy matching is a plain name check against the item's generic/brand name. It does not understand drug classes. */
function allergyAlerts(allergies: { substance: string; severity?: string }[], items: Item[]): RxAlert[] {
  const out: RxAlert[] = [];
  for (const it of items) for (const a of allergies) {
    const sub = a.substance.trim().toLowerCase();
    if (sub && (it.name.toLowerCase().includes(sub) || (it.genericName ?? "").toLowerCase().includes(sub))) {
      out.push({ type: "allergy", message: `Patient allergy "${a.substance}"${a.severity ? ` (${a.severity})` : ""} matches ${it.name}`, blocking: true });
    }
  }
  return out;
}

export async function createPrescription(ctx: Ctx, input: { encounterId: string; lines: z.input<typeof LineInput>[] }): Promise<Prescription> {
  assertPermission(ctx, "pharmacy:create");
  const p = z.object({ encounterId: z.string(), lines: z.array(LineInput).min(1) }).safeParse(input);
  if (!p.success) throw new AppError("VALIDATION", p.error.message);
  const enc = await getEncounterBrief(ctx, p.data.encounterId);
  const patient = await getPatient(ctx, enc.patientId);
  const itemRows: Item[] = [];
  for (const l of p.data.lines) {
    const it = await getItem(ctx, l.itemId);
    if (it.category !== "medicine") throw new AppError("VALIDATION", `${it.name} is not a medicine`);
    if (it.controlled) throw new AppError("CONFLICT", `${it.name} is a controlled medicine: electronic prescribing requires the regulator's authorization integration, which is not configured. Use the approved paper/regulatory process.`);
    itemRows.push(it);
  }
  const alerts: RxAlert[] = [...allergyAlerts(patient.allergies, itemRows)];
  const active = await rxs(ctx.orgId).find({ patientId: enc.patientId, status: { $in: ["signed", "verified", "partially_dispensed", "dispensed"] }, createdAt: { $gte: new Date(Date.now() - 30 * 86400000) } } as never);
  for (const it of itemRows) if (active.some((r) => r.lines.some((l) => l.itemId === it._id))) alerts.push({ type: "duplicate", message: `${it.name} was already prescribed to this patient in the last 30 days`, blocking: false });
  alerts.push({ type: "interaction_not_checked", message: INTERACTION_NOTE, blocking: false });

  return withTransaction(async (s) => {
    const year = yearOf();
    const rx: Prescription = {
      _id: newId(), number: docNo("RX", year, await nextSeq(ctx.orgId, `rx:${year}`, s)), encounterId: enc._id, patientId: enc.patientId, doctorId: enc.doctorId, status: "draft",
      lines: p.data.lines.map((l, i) => ({ ...l, name: itemRows[i].name, substitutionAllowed: l.substitutionAllowed ?? false, dispensed: 0 })), alerts, createdBy: ctx.userId, createdAt: new Date(),
    };
    await rxs(ctx.orgId).insertOne(rx, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "rx.create", resource: "prescription", resourceId: rx._id, after: { number: rx.number, alerts: alerts.map((a) => a.type) } });
    return rx;
  });
}

/** Only the prescriber signs. Blocking alerts (allergy) need a documented override reason. Never automatic. */
export async function signPrescription(ctx: Ctx, id: string, opts: { overrideReason?: string } = {}): Promise<Prescription> {
  assertPermission(ctx, "emr:approve");
  return withTransaction(async (s) => {
    const rx = await rxs(ctx.orgId).findOne({ _id: id } as never, s);
    if (!rx) throw new AppError("NOT_FOUND", "Prescription not found");
    if (rx.createdBy !== ctx.userId) throw new AppError("FORBIDDEN", "Only the prescriber can sign this prescription");
    if (rx.status !== "draft") throw new AppError("CONFLICT", `Prescription is ${rx.status}`);
    if (rx.alerts.some((a) => a.blocking) && !opts.overrideReason?.trim()) throw new AppError("CONFLICT", "Allergy alert: document an override reason or change the prescription");
    await rxs(ctx.orgId).updateOne({ _id: id, status: "draft" } as never, { $set: { status: "signed", signedAt: new Date(), ...(opts.overrideReason ? { overrideReason: opts.overrideReason } : {}) } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "rx.sign", resource: "prescription", resourceId: id, after: { override: opts.overrideReason ?? null } });
    await emit(s, ctx.orgId, "rx.signed", { prescriptionId: id });
    return { ...rx, status: "signed" };
  });
}

export async function verifyPrescription(ctx: Ctx, id: string, opts: { patientConfirmed: boolean }): Promise<void> {
  assertPermission(ctx, "pharmacy:approve");
  if (!opts.patientConfirmed) throw new AppError("VALIDATION", "Confirm patient identity before verification");
  await withTransaction(async (s) => {
    const res = await rxs(ctx.orgId).updateOne({ _id: id, status: "signed" } as never, { $set: { status: "verified", verifiedBy: ctx.userId, verifiedAt: new Date() } } as never, s);
    if (res.matchedCount === 0) throw new AppError("CONFLICT", "Prescription is not awaiting verification");
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "rx.verify", resource: "prescription", resourceId: id });
  });
}

export async function dispensingQueue(ctx: Ctx) {
  assertPermission(ctx, "pharmacy:view");
  return rxs(ctx.orgId).find({ status: { $in: ["signed", "verified", "partially_dispensed"] } } as never, { sort: { signedAt: 1 }, limit: 200 });
}
export async function getPrescription(ctx: Ctx, id: string) {
  assertPermission(ctx, "pharmacy:view");
  const rx = await rxs(ctx.orgId).findOne({ _id: id } as never);
  if (!rx) throw new AppError("NOT_FOUND", "Prescription not found");
  return rx;
}

/**
 * Dispense: FEFO batch deduction, COGS journal (Dr COGS / Cr Inventory at batch cost) and an unbilled pharmacy charge,
 * all in one transaction. Partial dispensing and approved substitution supported. Idempotent per key.
 */
export async function dispense(
  ctx: Ctx, input: { prescriptionId: string; locationId: string; idempotencyKey: string; lines: { itemId: string; qty: number; substituteItemId?: string }[] },
): Promise<Dispensing> {
  assertPermission(ctx, "pharmacy:update");
  const prior = await disp(ctx.orgId).findOne({ idempotencyKey: input.idempotencyKey } as never);
  if (prior) return prior;
  const run = () => withTransaction(async (s) => {
    const again = await disp(ctx.orgId).findOne({ idempotencyKey: input.idempotencyKey } as never, s);
    if (again) return again;
    const rx = await rxs(ctx.orgId).findOne({ _id: input.prescriptionId } as never, s);
    if (!rx) throw new AppError("NOT_FOUND", "Prescription not found");
    if (!["verified", "partially_dispensed"].includes(rx.status)) throw new AppError("CONFLICT", `Prescription is ${rx.status}; it must be verified by a pharmacist before dispensing`);
    const dispId = newId();
    const lines: DispenseLine[] = [];
    const cogsByAccount = new Map<string, ReturnType<typeof money>>();
    const rxLines = rx.lines.map((l) => ({ ...l }));
    for (const l of input.lines) {
      const rl = rxLines.find((x) => x.itemId === l.itemId);
      if (!rl) throw new AppError("VALIDATION", "Item is not on this prescription");
      if (!Number.isInteger(l.qty) || l.qty <= 0) throw new AppError("VALIDATION", "Quantity must be a positive whole number");
      if (rl.dispensed + l.qty > rl.qty) throw new AppError("VALIDATION", `Cannot dispense more than prescribed (${rl.qty - rl.dispensed} left for ${rl.name})`);
      let outId = l.itemId;
      if (l.substituteItemId && l.substituteItemId !== l.itemId) {
        if (!rl.substitutionAllowed) throw new AppError("CONFLICT", "The prescriber did not allow substitution for this item");
        if (!ctx.permissions.includes("pharmacy:approve")) throw new AppError("FORBIDDEN", "Substitution needs pharmacist approval");
        outId = l.substituteItemId;
      }
      const outItem = await tenantCol<Item>(ctx.orgId, "inv_items").findOne({ _id: outId, active: true } as never, s);
      if (!outItem) throw new AppError("NOT_FOUND", "Item not found");
      if (outItem.controlled) throw new AppError("CONFLICT", "Controlled medicines cannot be dispensed electronically here");
      const al = await allocateFefo(ctx, { itemId: outId, locationId: input.locationId, qty: l.qty, refType: "dispensing", refId: dispId }, s);
      const cogs = allocationValue(al);
      const sys = inventoryAccountSystem(outItem);
      cogsByAccount.set(sys, (cogsByAccount.get(sys) ?? money(0)).plus(cogs));
      rl.dispensed += l.qty;
      await createItemCharge(ctx, {
        encounterId: rx.encounterId, patientId: rx.patientId, doctorId: rx.doctorId, item: outItem, qty: l.qty, kind: "pharmacy",
        revenueAccountSystem: "rev_pharmacy", autoKey: `dispense:${dispId}:${outId}`,
      }, s);
      lines.push({ itemId: l.itemId, dispensedItemId: outId, name: outItem.name, qty: l.qty, returned: 0, allocations: al, substitute: outId !== l.itemId, cogs: toDecimal128(cogs) });
    }
    const totalCogs = sum([...cogsByAccount.values()]);
    const je = await postJournalSystem(ctx, {
      date: new Date(), memo: `Dispensing ${rx.number}`, sourceRef: { type: "dispensing", id: dispId }, idempotencyKey: `dispense:${input.idempotencyKey}`,
      lines: [
        { accountId: (await accountBySystem(ctx.orgId, "cogs_pharmacy"))._id, debit: totalCogs.toFixed(2) },
        ...(await Promise.all([...cogsByAccount].map(async ([sys, v]) => ({ accountId: (await accountBySystem(ctx.orgId, sys))._id, credit: v.toFixed(2) })))),
      ],
    }, s);
    const done = rxLines.every((l) => l.dispensed === l.qty);
    await rxs(ctx.orgId).updateOne({ _id: rx._id } as never, { $set: { lines: rxLines, status: done ? "dispensed" : "partially_dispensed" } } as never, s);
    const d: Dispensing = { _id: dispId, prescriptionId: rx._id, encounterId: rx.encounterId, patientId: rx.patientId, lines, idempotencyKey: input.idempotencyKey, at: new Date(), by: ctx.userId, journalEntryId: je._id };
    await disp(ctx.orgId).insertOne(d, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "rx.dispense", resource: "prescription", resourceId: rx._id, after: { dispensingId: dispId, lines: lines.map((x) => [x.name, x.qty]) } });
    await emit(s, ctx.orgId, "rx.dispensed", { dispensingId: dispId });
    return d;
  });
  try { return await run(); } catch (e) {
    if ((e as { code?: number }).code === 11000) { const won = await disp(ctx.orgId).findOne({ idempotencyKey: input.idempotencyKey } as never); if (won) return won; }
    throw e;
  }
}

/** Return to stock: stock back into the original batch, COGS reversed at cost, unbilled charge reduced. */
export async function returnMedication(ctx: Ctx, input: { dispensingId: string; itemId: string; qty: number; reason: string }): Promise<void> {
  assertPermission(ctx, "pharmacy:update");
  if (!input.reason.trim()) throw new AppError("VALIDATION", "Reason required");
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new AppError("VALIDATION", "Quantity must be a positive whole number");
  await withTransaction(async (s) => {
    const d = await disp(ctx.orgId).findOne({ _id: input.dispensingId } as never, s);
    if (!d) throw new AppError("NOT_FOUND", "Dispensing record not found");
    const line = d.lines.find((l) => l.dispensedItemId === input.itemId);
    if (!line) throw new AppError("NOT_FOUND", "Item was not dispensed on this record");
    if (line.returned + input.qty > line.qty) throw new AppError("VALIDATION", "Return exceeds the dispensed quantity");
    let left = input.qty, value = money(0);
    const sorted = [...line.allocations].reverse();
    const used = new Map<string, number>(line.allocations.map((a) => [a.batchId, 0]));
    for (const a of sorted) {
      if (left === 0) break;
      const take = Math.min(left, a.qty);
      value = value.plus(await returnToBatch(ctx, { batchId: a.batchId, qty: take, refType: "return", refId: d._id }, s));
      used.set(a.batchId, take);
      left -= take;
    }
    const item = (await tenantCol<Item>(ctx.orgId, "inv_items").findOne({ _id: input.itemId } as never, s))!;
    await postJournalSystem(ctx, {
      date: new Date(), memo: `Medication return: ${input.reason}`, sourceRef: { type: "med_return", id: d._id }, idempotencyKey: `medreturn:${newId()}`,
      lines: [
        { accountId: (await accountBySystem(ctx.orgId, inventoryAccountSystem(item)))._id, debit: value.toFixed(2) },
        { accountId: (await accountBySystem(ctx.orgId, "cogs_pharmacy"))._id, credit: value.toFixed(2) },
      ],
    }, s);
    await reduceItemCharge(ctx, d.encounterId, `dispense:${d._id}:${input.itemId}`, input.qty, s);
    const lines = d.lines.map((l) => (l === line ? { ...l, returned: l.returned + input.qty } : l));
    await disp(ctx.orgId).updateOne({ _id: d._id } as never, { $set: { lines } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "rx.return", resource: "dispensing", resourceId: d._id, after: { itemId: input.itemId, qty: input.qty, reason: input.reason } });
  });
}

export async function requestRefill(ctx: Ctx, prescriptionId: string, note: string): Promise<{ _id: string }> {
  assertPermission(ctx, "pharmacy:update");
  const rx = await getPrescription(ctx, prescriptionId);
  if (!["dispensed", "partially_dispensed"].includes(rx.status)) throw new AppError("CONFLICT", "Only dispensed prescriptions can be refilled");
  const doc = { _id: newId(), prescriptionId, status: "pending", note, requestedBy: ctx.userId, at: new Date() };
  await withTransaction(async (s) => {
    await tenantCol(ctx.orgId, "refill_requests").insertOne(doc as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "rx.refill_request", resource: "prescription", resourceId: prescriptionId });
  });
  return doc;
}

/** Prescriber decision. Approval creates a NEW DRAFT prescription for the doctor to review and sign; nothing is authorised automatically. */
export async function decideRefill(ctx: Ctx, refillId: string, approved: boolean): Promise<Prescription | null> {
  assertPermission(ctx, "emr:approve");
  return withTransaction(async (s) => {
    const rf = await tenantCol<{ _id: string; prescriptionId: string; status: string }>(ctx.orgId, "refill_requests").findOne({ _id: refillId } as never, s);
    if (!rf || rf.status !== "pending") throw new AppError("CONFLICT", "Refill request not found or already decided");
    await tenantCol(ctx.orgId, "refill_requests").updateOne({ _id: refillId } as never, { $set: { status: approved ? "approved" : "rejected", decidedBy: ctx.userId } } as never, s);
    if (!approved) return null;
    const old = (await rxs(ctx.orgId).findOne({ _id: rf.prescriptionId } as never, s))!;
    const year = yearOf();
    const draft: Prescription = {
      ...old, _id: newId(), number: docNo("RX", year, await nextSeq(ctx.orgId, `rx:${year}`, s)), status: "draft", lines: old.lines.map((l) => ({ ...l, dispensed: 0 })),
      createdBy: ctx.userId, signedAt: undefined, verifiedBy: undefined, verifiedAt: undefined, overrideReason: undefined, refillOf: old._id, createdAt: new Date(),
    };
    await rxs(ctx.orgId).insertOne(draft, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "rx.refill_approve", resource: "prescription", resourceId: draft._id });
    return draft;
  });
}

export async function pharmacyDashboard(ctx: Ctx) {
  assertPermission(ctx, "pharmacy:view");
  const queue = await dispensingQueue(ctx);
  const alerts = await reorderAlerts(ctx).catch(() => []);
  const expiring = await nearExpiry(ctx, 90).catch(() => []);
  const sales = await tenantCol<{ qty: number; unitPrice: Decimal128 }>(ctx.orgId, "charges").find({ kind: "pharmacy", status: { $ne: "void" } } as never, { limit: 100000 });
  return {
    awaitingVerification: queue.filter((r) => r.status === "signed").length,
    readyToDispense: queue.filter((r) => r.status === "verified" || r.status === "partially_dispensed").length,
    lowStock: alerts.length,
    nearExpiry: expiring.length,
    pharmacySales: sum(sales.map((c) => fromDecimal128(c.unitPrice).times(c.qty))).toFixed(2),
    medicines: (await listItems(ctx, { category: "medicine" }).catch(() => [])).length,
  };
}

void (null as unknown as ClientSession);
