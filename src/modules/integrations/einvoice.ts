import type { Decimal128 } from "mongodb";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { emit } from "@/core/outbox";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { fromDecimal128, money, round2, sum } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { getInvoice } from "@/modules/billing/invoice";
import { getPatient } from "@/modules/patients/service";
import type { CreditNote } from "@/modules/billing/types";

/**
 * Internal structured e-invoice model, versioned. It is NOT a certified UAE e-invoicing payload (the national format, PINT-AE/Peppol
 * profile and Accredited Service Provider rules are published by the Ministry of Finance/FTA and must be mapped before go-live).
 * A PDF or printed invoice is not a structured e-invoice.
 */
export const SPEC_VERSION = "internal-0.1";

export type EInvoice = {
  specVersion: string; documentType: "380" | "381"; number: string; issueDate: string; currency: "AED"; precedingInvoice?: string;
  seller: { name: string; trn?: string }; buyer: { name: string; reference?: string };
  lines: { id: number; description: string; quantity: number; unitPrice: string; taxCategory: "S" | "Z" | "E" | "O"; taxRate: string; net: string; tax: string }[];
  taxTotals: { category: string; rate: string; taxable: string; tax: string }[]; totals: { net: string; tax: string; gross: string };
};

const CAT: Record<string, "S" | "Z" | "E"> = { standard: "S", zero: "Z", exempt: "E" };

export function validateEInvoice(e: EInvoice): string[] {
  const err: string[] = [];
  if (!e.seller.trn || !/^\d{15}$/.test(e.seller.trn)) err.push("Seller TRN must be a 15-digit tax registration number");
  if (!e.seller.name) err.push("Seller name missing");
  if (!e.buyer.name) err.push("Buyer name missing");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.issueDate)) err.push("Issue date invalid");
  if (!e.lines.length) err.push("At least one line is required");
  if (e.documentType === "381" && !e.precedingInvoice) err.push("Credit note must reference the original invoice");
  const net = sum(e.lines.map((l) => money(l.net))), tax = sum(e.lines.map((l) => money(l.tax)));
  if (!net.equals(money(e.totals.net))) err.push("Header net total does not equal the sum of lines");
  if (!tax.equals(money(e.totals.tax))) err.push("Header tax total does not equal the sum of lines");
  if (!net.plus(tax).equals(money(e.totals.gross))) err.push("Gross total is inconsistent");
  for (const l of e.lines) if (!money(l.net).equals(round2(money(l.unitPrice).times(l.quantity)))) err.push(`Line ${l.id}: net != quantity x unit price`);
  return err;
}

const m2 = (d: Decimal128 | undefined) => fromDecimal128(d).toFixed(2);

async function build(ctx: Ctx, invoiceId: string, creditNote?: CreditNote): Promise<EInvoice> {
  const inv = await getInvoice(ctx, invoiceId);
  const patient = await getPatient(ctx, inv.patientId);
  const org = await tenantCol<{ name: string; trn?: string }>(ctx.orgId, "orgs").findOne({ _id: ctx.orgId } as never);
  const kinds = new Map((await tenantCol<{ code: string; kind: string }>(ctx.orgId, "tax_codes").find({} as never)).map((t) => [t.code, t.kind]));
  const lines = inv.lines.map((l, i) => ({
    id: i + 1, description: l.name, quantity: l.qty, unitPrice: m2(l.unitPrice), taxCategory: (CAT[kinds.get(l.taxCode) ?? ""] ?? "O") as "S" | "Z" | "E" | "O", taxRate: fromDecimal128(l.taxRate).toFixed(2), net: m2(l.net), tax: m2(l.vat),
  }));
  const groups = new Map<string, { category: string; rate: string; taxable: ReturnType<typeof money>; tax: ReturnType<typeof money> }>();
  for (const l of lines) { const k = `${l.taxCategory}|${l.taxRate}`; const g = groups.get(k) ?? { category: l.taxCategory, rate: l.taxRate, taxable: money(0), tax: money(0) }; g.taxable = g.taxable.plus(l.net); g.tax = g.tax.plus(l.tax); groups.set(k, g); }
  const net = sum(lines.map((l) => money(l.net))), tax = sum(lines.map((l) => money(l.tax)));
  return {
    specVersion: SPEC_VERSION, documentType: creditNote ? "381" : "380", number: creditNote ? creditNote.number : inv.number, issueDate: (creditNote?.at ?? inv.createdAt).toISOString().slice(0, 10), currency: "AED",
    ...(creditNote ? { precedingInvoice: inv.number } : {}), seller: { name: org?.name ?? "", trn: org?.trn }, buyer: { name: patient.fullName, reference: patient.mrn }, lines,
    taxTotals: [...groups.values()].map((g) => ({ category: g.category, rate: g.rate, taxable: g.taxable.toFixed(2), tax: g.tax.toFixed(2) })), totals: { net: net.toFixed(2), tax: tax.toFixed(2), gross: net.plus(tax).toFixed(2) },
  };
}
export async function buildEInvoice(ctx: Ctx, invoiceId: string) { assertPermission(ctx, "billing:view"); const e = await build(ctx, invoiceId); return { invoice: e, errors: validateEInvoice(e) }; }

export type AspResult = { reference: string; status: "accepted" | "rejected"; errors: string[] };
/** Accredited Service Provider boundary. None is configured: only a sandbox that checks the payload and transmits nothing. */
export type AspAdapter = { name: string; mode: "sandbox" | "production"; submit(e: EInvoice): Promise<AspResult> };
export const sandboxAsp: AspAdapter = { name: "sandbox-asp", mode: "sandbox", async submit(e) { const errors = validateEInvoice(e); return { reference: `SBXASP-${e.number}`, status: errors.length ? "rejected" : "accepted", errors }; } };

export type EInvoiceSubmission = { _id: string; invoiceId: string; creditNoteId?: string; number: string; version: number; specVersion: string; mode: string; adapter: string; status: "accepted" | "rejected"; reference: string; errors: string[]; payload: EInvoice; at: Date; by: string };
const subs = (o: string) => tenantCol<EInvoiceSubmission>(o, "einvoice_submissions");

/** Never sends a payload that fails local validation. Accepted documents are not re-submitted. */
export async function submitEInvoice(ctx: Ctx, input: { invoiceId: string; creditNoteId?: string }, asp: AspAdapter = sandboxAsp): Promise<EInvoiceSubmission> {
  assertPermission(ctx, "billing:approve");
  const cn = input.creditNoteId ? await tenantCol<CreditNote>(ctx.orgId, "credit_notes").findOne({ _id: input.creditNoteId, invoiceId: input.invoiceId } as never) : undefined;
  if (input.creditNoteId && !cn) throw new AppError("NOT_FOUND", "Credit note not found");
  const doc = await build(ctx, input.invoiceId, cn ?? undefined);
  const prior = await subs(ctx.orgId).find({ number: doc.number } as never, { sort: { version: -1 } });
  if (prior[0]?.status === "accepted") throw new AppError("CONFLICT", "This document was already accepted");
  const local = validateEInvoice(doc);
  const res: AspResult = local.length ? { reference: "", status: "rejected", errors: local } : await asp.submit(doc);
  const row: EInvoiceSubmission = { _id: newId(), invoiceId: input.invoiceId, creditNoteId: input.creditNoteId, number: doc.number, version: (prior[0]?.version ?? 0) + 1, specVersion: SPEC_VERSION, mode: asp.mode, adapter: asp.name, status: res.status, reference: res.reference, errors: res.errors, payload: doc, at: new Date(), by: ctx.userId };
  await withTransaction(async (s) => {
    await subs(ctx.orgId).insertOne(row, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: `einvoice.${res.status}`, resource: "einvoice", resourceId: row._id, after: { number: doc.number, errors: res.errors, mode: asp.mode } });
    await emit(s, ctx.orgId, "einvoice.submitted", { submissionId: row._id });
  });
  return row;
}
/** Latest status per document, with rejected ones first for error reconciliation. */
export async function eInvoiceStatus(ctx: Ctx) {
  assertPermission(ctx, "billing:view");
  const all = await subs(ctx.orgId).find({} as never, { sort: { version: 1 }, limit: 5000 });
  const latest = new Map(all.map((s) => [s.number, s]));
  return [...latest.values()].sort((a, b) => (a.status === b.status ? 0 : a.status === "rejected" ? -1 : 1));
}
