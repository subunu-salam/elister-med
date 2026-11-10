import type { Ctx } from "@/core/rbac/authorize";
import { AppError } from "@/core/errors";
import * as ecl from "@/modules/integrations/eclaimlink/service";
import * as ct from "@/modules/tax/corporateTax";
import * as fa from "@/modules/assets/service";
import * as exp from "@/modules/finance/expenses";
import * as bk from "@/modules/books/service";
import * as items from "@/modules/accounts/items";
import * as coa from "@/modules/ledger/coa";
import { postJournal, reverseJournal } from "@/modules/ledger/journal";
import { lockPeriod } from "@/modules/ledger/periods";
import * as ins from "@/modules/insurance/masters";
import * as claims from "@/modules/insurance/claims";
import * as inv from "@/modules/inventory/service";
import * as rx from "@/modules/pharmacy/service";
import * as proc from "@/modules/procurement/service";
import * as lab from "@/modules/laboratory/service";
import * as rad from "@/modules/radiology/service";
import * as hr from "@/modules/hr/service";
import * as crm from "@/modules/crm/service";
import * as comm from "@/modules/communications/service";
import * as comp from "@/modules/compliance/service";
import * as cash from "@/modules/finance/cashbank";
import * as st from "@/modules/finance/statements";
import * as drafts from "@/modules/ledger/drafts";
import * as hosp from "@/modules/hospital/service";
import * as spec from "@/modules/specialty/service";
import * as ai from "@/modules/ai/service";
import * as portal from "@/modules/portal/service";
import * as prefs from "@/modules/prefs/service";
import * as hie from "@/modules/integrations/hie";
import * as einv from "@/modules/integrations/einvoice";
import { markAllRead } from "@/core/notify";
import { randomUUID } from "node:crypto";

type Act = (ctx: Ctx, fd: FormData, back: string) => Promise<string | void>;
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const o = (fd: FormData, k: string) => (s(fd, k) ? s(fd, k) : undefined);
const n = (fd: FormData, k: string) => { const v = s(fd, k); if (v === "") throw new AppError("VALIDATION", `${k} is required`); const x = Number(v); if (!Number.isFinite(x)) throw new AppError("VALIDATION", `${k} must be a number`); return x; };
const on = (fd: FormData, k: string) => (s(fd, k) === "" ? undefined : n(fd, k));
const b = (fd: FormData, k: string) => fd.get(k) === "on";
const dt = (fd: FormData, k: string, tz = true) => { const v = s(fd, k); if (!v) throw new AppError("VALIDATION", `${k} is required`); const d = new Date(v.length === 10 ? `${v}T00:00:00+04:00` : tz ? `${v}:00+04:00`.replace(/:00:00\+/, ":00+") : v); if (Number.isNaN(+d)) throw new AppError("VALIDATION", `${k} is not a valid date`); return d; };
const od = (fd: FormData, k: string) => (s(fd, k) ? dt(fd, k) : undefined);
const list = (fd: FormData, k: string) => s(fd, k).split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const key = (fd: FormData) => o(fd, "idem") ?? randomUUID();

export const ACTIONS: Record<string, Act> = {
  // ---------- corporate tax, fixed assets, expenses ----------
  "tax.config": async (c, f) => { await ct.setTaxConfig(c, { trn: o(f, "trn"), registered: b(f, "registered"), sbrElected: b(f, "sbr"), firstYear: on(f, "firstYear"), lossesBroughtForward: o(f, "losses") ?? "0.00", notes: o(f, "notes") }); },
  "tax.adjust": async (c, f) => { await ct.addTaxAdjustment(c, { year: n(f, "year"), kind: s(f, "kind") as "add_back" | "deduct", label: s(f, "label"), amount: s(f, "amount"), note: o(f, "note") }); },
  "tax.adjustRemove": async (c, f) => { await ct.removeTaxAdjustment(c, s(f, "id")); },
  "tax.provision": async (c, f) => { await ct.provisionCorporateTax(c, n(f, "year")); },
  "tax.pay": async (c, f) => { await ct.payCorporateTax(c, { year: n(f, "year"), amount: s(f, "amount"), method: s(f, "method") === "cash" ? "cash" : "bank", idempotencyKey: key(f) }); },
  "tax.file": async (c, f) => { await ct.markReturnFiled(c, { year: n(f, "year"), reference: s(f, "reference") }); },
  "asset.add": async (c, f) => { await fa.registerAsset(c, { name: s(f, "name"), category: s(f, "category"), cost: s(f, "cost"), vat: o(f, "vat"), residual: o(f, "residual"), lifeMonths: n(f, "life"), purchaseDate: dt(f, "date"), paidFrom: s(f, "paidFrom") as "bank", vendor: o(f, "vendor"), location: o(f, "location"), serial: o(f, "serial") }); },
  "asset.depreciate": async (c, f) => { await fa.runDepreciation(c, s(f, "period")); },
  "asset.dispose": async (c, f) => { await fa.disposeAsset(c, { id: s(f, "id"), proceeds: s(f, "proceeds"), method: s(f, "method") === "cash" ? "cash" : "bank" }); },
  "exp.add": async (c, f) => { await exp.recordExpense(c, { date: od(f, "date"), category: s(f, "category"), vendor: s(f, "vendor"), reference: o(f, "reference"), description: s(f, "description"), net: s(f, "net"), vatRate: s(f, "vat") as "STD", paidFrom: s(f, "paidFrom") as "bank", treatment: s(f, "treatment") as "deductible", idempotencyKey: key(f) }); },

  // ---------- business books: corporate customers, documents, receipts, credits, banking, chart of accounts ----------
  "bk.customer": async (c, f) => { await bk.createCustomer(c, { name: s(f, "name"), trn: o(f, "trn"), email: o(f, "email"), phone: o(f, "phone"), termsDays: on(f, "terms") ?? 30 }); },
  "bk.docCreate": async (c, f) => { await bk.createSalesDoc(c, { kind: s(f, "kind") as bk.DocKind, customerId: s(f, "customerId"), date: od(f, "date"), lines: bk.parseLines(s(f, "lines"), "4500"), notes: o(f, "notes") }); },
  "bk.docStatus": async (c, f) => { await bk.setSalesDocStatus(c, s(f, "id"), s(f, "status") as "sent"); },
  "bk.docConvert": async (c, f) => { await bk.convertSalesDoc(c, s(f, "id"), s(f, "to") as "invoice"); },
  "bk.invCreate": async (c, f) => { await bk.createInvoice(c, { customerId: s(f, "customerId"), issueDate: od(f, "date"), dueDate: od(f, "due"), lines: bk.parseLines(s(f, "lines"), "4500"), notes: o(f, "notes"), issue: b(f, "issue"), idempotencyKey: key(f) }); },
  "bk.invIssue": async (c, f) => { await bk.issueInvoice(c, s(f, "id")); },
  "bk.invVoid": async (c, f) => { await bk.voidInvoice(c, s(f, "id"), s(f, "reason")); },
  "bk.receipt": async (c, f) => { await bk.recordReceipt(c, { customerId: s(f, "customerId"), invoiceId: o(f, "invoiceId"), amount: s(f, "amount"), method: s(f, "method") as "bank", reference: o(f, "reference"), date: od(f, "date"), idempotencyKey: key(f) }); },
  "bk.applyCredit": async (c, f) => { await bk.applyCredit(c, { source: s(f, "source") as "receipt", sourceId: s(f, "sourceId"), invoiceId: s(f, "invoiceId") }); },
  "bk.creditNote": async (c, f) => { await bk.issueTradeCreditNote(c, { customerId: s(f, "customerId"), invoiceId: o(f, "invoiceId"), lines: bk.parseLines(s(f, "lines"), "4500"), reason: s(f, "reason"), idempotencyKey: key(f) }); },
  "bk.recCreate": async (c, f) => { await bk.createRecurring(c, { name: s(f, "name"), customerId: s(f, "customerId"), frequency: s(f, "frequency") as "monthly", startDate: dt(f, "start"), lines: bk.parseLines(s(f, "lines"), "4500") }); },
  "bk.recStatus": async (c, f) => { await bk.setRecurringStatus(c, s(f, "id"), s(f, "status") as "active"); },
  "bk.recGenerate": async (c, f) => { await bk.generateRecurring(c, s(f, "id")); },
  "bk.recRunDue": async (c, _f, back) => { const n2 = await bk.runDueRecurring(c); return `${back}${back.includes("?") ? "&" : "?"}notice=${encodeURIComponent(`${n2} recurring invoice(s) generated`)}`; },
  "bk.vendorCredit": async (c, f) => { await bk.recordVendorCredit(c, { supplierId: s(f, "supplierId"), supplierInvoiceId: o(f, "supplierInvoiceId"), lines: bk.parseLines(s(f, "lines"), "5800"), reason: s(f, "reason"), idempotencyKey: key(f) }); },
  "bk.bank": async (c, f) => { await bk.bankTransaction(c, { type: s(f, "type") as "deposit", account: s(f, "account") as "bank", otherCode: s(f, "other"), amount: s(f, "amount"), date: od(f, "date"), description: s(f, "description"), idempotencyKey: key(f) }); },
  "bk.lockThrough": async (c, f, back) => { const k = await bk.lockThrough(c, n(f, "year"), n(f, "month")); return `${back}${back.includes("?") ? "&" : "?"}notice=${encodeURIComponent(`${k} period(s) locked`)}`; },
  "coa.add": async (c, f) => { await coa.createAccount(c, { code: s(f, "code"), name: s(f, "name"), type: s(f, "type") as "asset" }); },
  "coa.rename": async (c, f) => { await coa.renameAccount(c, s(f, "code"), s(f, "name")); },
  "coa.active": async (c, f) => { await coa.setAccountActive(c, s(f, "code"), s(f, "active") === "1"); },
  "journal.manual": async (c, f) => {
    // one line per row: "account code | debit | credit"
    const k = key(f);
    const lines = s(f, "lines").split("\n").map((x) => x.trim()).filter(Boolean).map((row) => {
      const [code, d, cr] = row.split("|").map((x) => x.trim());
      if (!/^\d{4}$/.test(code ?? "")) throw new AppError("VALIDATION", `"${row}": start with a 4-digit account code`);
      return { accountId: `${c.orgId}:${code}`, debit: d || undefined, credit: cr || undefined };
    });
    await postJournal(c, { date: od(f, "date") ?? new Date(), memo: s(f, "memo"), lines, sourceRef: { type: "manual", id: k }, idempotencyKey: `manual:${k}` });
  },

  // ---------- Accounts (Zoho-style section): items + item-aware sales documents ----------
  "acc.item": async (c, f) => { await items.createItem(c, { sku: s(f, "sku"), name: s(f, "name"), kind: (o(f, "kind") ?? "service") as "service", unit: o(f, "unit"), description: o(f, "description"), rate: s(f, "rate"), vatRate: (o(f, "vat") ?? "STD") as "STD", incomeCode: o(f, "incomeCode") ?? "4500", purchaseRate: o(f, "purchaseRate"), expenseCode: o(f, "expenseCode") }); },
  "acc.itemRate": async (c, f) => { await items.updateItemRate(c, s(f, "id"), s(f, "rate")); },
  "acc.itemActive": async (c, f) => { await items.setItemActive(c, s(f, "id"), s(f, "active") === "1"); },
  "acc.docCreate": async (c, f) => { await bk.createSalesDoc(c, { kind: s(f, "kind") as bk.DocKind, customerId: s(f, "customerId"), date: od(f, "date"), lines: bk.parseLines(await items.expandItemLines(c, s(f, "lines")), "4500"), notes: o(f, "notes") }); },
  "acc.invCreate": async (c, f) => { await bk.createInvoice(c, { customerId: s(f, "customerId"), issueDate: od(f, "date"), dueDate: od(f, "due"), lines: bk.parseLines(await items.expandItemLines(c, s(f, "lines")), "4500"), notes: o(f, "notes"), issue: b(f, "issue"), idempotencyKey: key(f) }); },
  "acc.creditNote": async (c, f) => { await bk.issueTradeCreditNote(c, { customerId: s(f, "customerId"), invoiceId: o(f, "invoiceId"), lines: bk.parseLines(await items.expandItemLines(c, s(f, "lines")), "4500"), reason: s(f, "reason"), idempotencyKey: key(f) }); },
  "acc.recCreate": async (c, f) => { await bk.createRecurring(c, { name: s(f, "name"), customerId: s(f, "customerId"), frequency: s(f, "frequency") as "monthly", startDate: dt(f, "start"), lines: bk.parseLines(await items.expandItemLines(c, s(f, "lines")), "4500") }); },
  "acc.vendorCredit": async (c, f) => { await bk.recordVendorCredit(c, { supplierId: s(f, "supplierId"), supplierInvoiceId: o(f, "supplierInvoiceId"), lines: bk.parseLines(await items.expandItemLines(c, s(f, "lines"), "purchase"), "5800"), reason: s(f, "reason"), idempotencyKey: key(f) }); },
  "acc.reverse": async (c, f) => { await reverseJournal(c, s(f, "entryId"), s(f, "reason")); },
  "acc.lockPeriod": async (c, f) => { await lockPeriod(c, n(f, "year"), n(f, "month")); },

  // ---------- DHA eClaimLink ----------
  "ecl.config": async (c, f) => {
    const map: Record<string, string> = {};
    for (const line of list(f, "payerMap")) { const [k, v] = line.split("="); if (k && v) map[k.trim()] = v.trim(); }
    await ecl.setEclConfig(c, { mode: s(f, "mode") as ecl.EclMode, baseUrl: s(f, "baseUrl"), facilityId: s(f, "facilityId"), login: s(f, "login"), password: o(f, "password"), payerMap: map });
  },
  "ecl.test": async (c, _f, back) => { const r = await ecl.testConnection(c); return `${back}${back.includes("?") ? "&" : "?"}${r.ok ? "notice" : "error"}=${encodeURIComponent(r.message)}`; },
  "ecl.poll": async (c, _f, back) => { const r = await ecl.pollInbox(c); return `${back}${back.includes("?") ? "&" : "?"}notice=${encodeURIComponent(`${r.found} new: ${r.claimsPaid} paid, ${r.claimsPartial} part-paid, ${r.claimsDenied} denied, AED ${r.amountPaid} received, ${r.authApproved} approvals, ${r.authRefused} refusals${r.problems.length ? `. Problems: ${r.problems.join("; ")}` : ""}`)}`; },
  "ecl.preauthSend": async (c, f) => { await ecl.sendPriorAuth(c, s(f, "id")); },
  "ecl.eligibility": async (c, f, back) => { const r = await ecl.checkEligibilityEcl(c, s(f, "policyId")); return `${back}${back.includes("?") ? "&" : "?"}notice=${encodeURIComponent(`${r.eligible ? "Eligible" : "Not eligible"}: ${r.notes} (${r.reference})`)}`; },

  // ---------- insurance ----------
  "ins.payer": async (c, f) => { await ins.createPayer(c, { name: s(f, "name"), code: s(f, "code"), kind: s(f, "kind") as "insurer" | "tpa" }); },
  "ins.plan": async (c, f) => { await ins.createPlan(c, { payerId: s(f, "payerId"), name: s(f, "name"), copayPct: n(f, "copayPct"), copayCapPerVisit: o(f, "cap"), preauthServiceCodes: list(f, "preauth"), exclusions: list(f, "exclusions") }); },
  "ins.policy": async (c, f) => { await ins.createPolicy(c, { patientId: s(f, "patientId"), planId: s(f, "planId"), memberNo: s(f, "memberNo"), startDate: dt(f, "start"), endDate: dt(f, "end") }); },
  "ins.eligibility": async (c, f) => { await ins.recordEligibility(c, { patientId: s(f, "patientId"), policyId: s(f, "policyId"), result: s(f, "result") as "eligible", source: "manual", reference: o(f, "reference"), notes: o(f, "notes") }); },
  "ins.preauthRequest": async (c, f) => { await ins.requestPreauth(c, { patientId: s(f, "patientId"), policyId: s(f, "policyId"), serviceCodes: list(f, "codes"), estimatedAmount: s(f, "amount") }); },
  "ins.preauthDecide": async (c, f) => { await ins.decidePreauth(c, s(f, "id"), { approved: s(f, "decision") === "approve", approvedAmount: o(f, "amount"), reference: o(f, "reference") }); },
  "ins.invoice": async (c, f) => { const r = await claims.finalizeInsuredInvoice(c, { patientId: s(f, "patientId"), chargeIds: f.getAll("chargeId").map(String), policyId: s(f, "policyId") }); return `/insurance/claims/${r.claim._id}`; },
  "claim.validate": async (c, f) => { await claims.validateClaim(c, s(f, "id")); },
  "claim.submit": async (c, f) => { await claims.submitClaim(c, s(f, "id")); },
  "claim.response": async (c, f) => { await claims.recordPayerResponse(c, s(f, "id"), { outcome: s(f, "outcome") as "accepted" | "rejected", reason: o(f, "reason") }); },
  "claim.resubmit": async (c, f) => { await claims.resubmitClaim(c, s(f, "id")); },
  "claim.writeoff": async (c, f) => { await claims.writeOffClaim(c, s(f, "id"), s(f, "reason")); },
  "claim.remittance": async (c, f) => { await claims.postRemittance(c, { payerId: s(f, "payerId"), reference: s(f, "reference"), lines: [{ claimId: s(f, "claimId"), paid: s(f, "paid"), denied: o(f, "denied"), reason: o(f, "reason") }] }); },

  // ---------- inventory / pharmacy ----------
  "inv.item": async (c, f) => { await inv.createItem(c, { sku: s(f, "sku"), name: s(f, "name"), genericName: o(f, "generic"), category: s(f, "category") as "medicine", reorderLevel: on(f, "reorderLevel") ?? 0, reorderQty: on(f, "reorderQty") ?? 0, sellingPrice: o(f, "price"), controlled: b(f, "controlled"), strength: o(f, "strength"), form: o(f, "form"), manufacturer: o(f, "manufacturer") }); },
  "inv.adjust": async (c, f) => { await inv.adjustStock(c, { batchId: s(f, "batchId"), delta: n(f, "delta"), reason: s(f, "reason"), kind: s(f, "kind") === "wastage" ? "wastage" : "adjustment" }); },
  "inv.transfer": async (c, f) => { await inv.transferStock(c, { batchId: s(f, "batchId"), toLocationId: s(f, "to"), qty: n(f, "qty") }); },
  "rx.create": async (c, f) => { const r = await rx.createPrescription(c, { encounterId: s(f, "encounterId"), lines: [{ itemId: s(f, "itemId"), dose: s(f, "dose"), frequency: s(f, "frequency"), durationDays: n(f, "days"), qty: n(f, "qty"), instructions: o(f, "instructions"), substitutionAllowed: b(f, "sub") }] }); return `/pharmacy/${r._id}`; },
  "rx.sign": async (c, f) => { await rx.signPrescription(c, s(f, "id"), { overrideReason: o(f, "override") }); },
  "rx.verify": async (c, f) => { await rx.verifyPrescription(c, s(f, "id"), { patientConfirmed: b(f, "confirmed") }); },
  "rx.dispense": async (c, f) => { await rx.dispense(c, { prescriptionId: s(f, "id"), locationId: s(f, "location"), idempotencyKey: key(f), lines: [{ itemId: s(f, "itemId"), qty: n(f, "qty"), substituteItemId: o(f, "substitute") }] }); },
  "rx.return": async (c, f) => { await rx.returnMedication(c, { dispensingId: s(f, "dispensingId"), itemId: s(f, "itemId"), qty: n(f, "qty"), reason: s(f, "reason") }); },
  "rx.refundRequest": async (c, f) => { await rx.requestRefill(c, s(f, "id"), s(f, "note") || "Refill requested"); },
  "rx.refillDecide": async (c, f) => { await rx.decideRefill(c, s(f, "id"), s(f, "decision") === "approve"); },

  // ---------- procurement ----------
  "proc.supplier": async (c, f) => { await proc.createSupplier(c, { name: s(f, "name"), trn: o(f, "trn"), termsDays: on(f, "terms") ?? 30 }); },
  "proc.pr": async (c, f) => { await proc.createPurchaseRequest(c, { lines: [{ itemId: s(f, "itemId"), qty: n(f, "qty") }], note: o(f, "note") }); },
  "proc.reorder": async (c) => { await proc.createReorderRequests(c); },
  "proc.prDecide": async (c, f) => { await proc.decidePurchaseRequest(c, s(f, "id"), s(f, "decision") === "approve"); },
  "proc.po": async (c, f) => { await proc.createPurchaseOrder(c, { supplierId: s(f, "supplierId"), prId: o(f, "prId"), lines: [{ itemId: s(f, "itemId"), qty: n(f, "qty"), unitCost: s(f, "unitCost") }] }); },
  "proc.poIssue": async (c, f) => { await proc.issuePurchaseOrder(c, s(f, "id")); },
  "proc.grn": async (c, f) => { await proc.receiveGoods(c, { poId: s(f, "poId"), locationId: s(f, "location") || "pharmacy", idempotencyKey: key(f), lines: [{ itemId: s(f, "itemId"), qty: n(f, "qty"), batchNo: s(f, "batchNo"), expiry: dt(f, "expiry") }] }); },
  "proc.invoice": async (c, f) => { await proc.recordSupplierInvoice(c, { supplierId: s(f, "supplierId"), poId: o(f, "poId"), invoiceNo: s(f, "invoiceNo"), invoiceDate: dt(f, "invoiceDate"), dueDate: dt(f, "dueDate"), net: s(f, "net"), vat: s(f, "vat") || "0" }); },
  "proc.invoiceApprove": async (c, f) => { await proc.approveSupplierInvoice(c, s(f, "id")); },
  "proc.pay": async (c, f) => { await proc.paySupplier(c, { invoiceId: s(f, "invoiceId"), amount: s(f, "amount"), method: s(f, "method") as "bank", idempotencyKey: key(f) }); },

  // ---------- laboratory / radiology ----------
  "lab.test": async (c, f) => { await lab.createLabTest(c, { code: s(f, "code"), name: s(f, "name"), loinc: o(f, "loinc"), specimen: s(f, "specimen"), unit: s(f, "unit"), serviceId: o(f, "serviceId"), ranges: [{ sex: (o(f, "sex") as "male" | undefined), low: n(f, "low"), high: n(f, "high"), criticalLow: on(f, "critLow"), criticalHigh: on(f, "critHigh") }] }); },
  "lab.approveRanges": async (c, f) => { await lab.approveRanges(c, s(f, "id")); },
  "lab.order": async (c, f) => { await lab.orderLab(c, { encounterId: s(f, "encounterId"), testIds: f.getAll("testId").map(String), priority: (o(f, "priority") as "routine") ?? "routine" }); },
  "lab.collect": async (c, f) => { await lab.collectSample(c, s(f, "id")); },
  "lab.receive": async (c, f) => { await lab.receiveSample(c, s(f, "id")); },
  "lab.process": async (c, f) => { await lab.startProcessing(c, s(f, "id")); },
  "lab.result": async (c, f) => { await lab.enterResult(c, { orderId: s(f, "orderId"), testId: s(f, "testId"), value: n(f, "value") }); },
  "lab.verify": async (c, f) => { await lab.verifyResults(c, s(f, "id")); },
  "lab.release": async (c, f) => { await lab.releaseOrder(c, s(f, "id")); },
  "lab.ack": async (c, f) => { await lab.acknowledgeCritical(c, s(f, "id"), s(f, "note")); },
  "rad.order": async (c, f) => { await rad.orderImaging(c, { encounterId: s(f, "encounterId"), modality: s(f, "modality") as "XR", study: s(f, "study"), serviceId: o(f, "serviceId") }); },
  "rad.schedule": async (c, f) => { await rad.scheduleImaging(c, s(f, "id"), dt(f, "when")); },
  "rad.perform": async (c, f) => { await rad.markPerformed(c, s(f, "id"), o(f, "pacsRef")); },
  "rad.report": async (c, f) => { await rad.writeReport(c, s(f, "id"), { findings: s(f, "findings"), impression: s(f, "impression") }); },
  "rad.release": async (c, f) => { await rad.releaseReport(c, s(f, "id")); },

  // ---------- HR ----------
  "hr.employee": async (c, f) => { await hr.createEmployee(c, { name: s(f, "name"), nameAr: o(f, "nameAr"), role: s(f, "role"), joinDate: dt(f, "joinDate"), contractType: s(f, "contractType") as "limited", contractStart: dt(f, "contractStart"), basic: s(f, "basic"), allowances: o(f, "allowance") ? [{ name: "Allowance", amount: s(f, "allowance") }] : [], licence: o(f, "licenceNo") ? { authority: s(f, "authority") as "DHA", number: s(f, "licenceNo"), expiry: dt(f, "licenceExpiry") } : undefined, emiratesIdExpiry: od(f, "eidExpiry"), visaExpiry: od(f, "visaExpiry"), iban: o(f, "iban") }); },
  "hr.config": async (c, f) => { await hr.setHrConfig(c, { standardDailyHours: n(f, "hours"), overtimeMultiplier: n(f, "ot"), workingDaysPerMonth: n(f, "days") }); },
  "hr.leaveType": async (c, f) => { await hr.defineLeaveType(c, { code: s(f, "code").toUpperCase(), name: s(f, "name"), daysPerYear: n(f, "days"), paid: b(f, "paid") }); },
  "hr.leave": async (c, f) => { await hr.requestLeave(c, { employeeId: s(f, "employeeId"), typeCode: s(f, "typeCode"), from: s(f, "from"), to: s(f, "to"), reason: o(f, "reason") }); },
  "hr.leaveDecide": async (c, f) => { await hr.decideLeave(c, s(f, "id"), s(f, "decision") === "approve"); },
  "hr.clockIn": async (c, f) => { await hr.clockIn(c, s(f, "employeeId")); },
  "hr.clockOut": async (c, f) => { await hr.clockOut(c, s(f, "employeeId")); },
  "hr.advance": async (c, f) => { await hr.grantAdvance(c, { employeeId: s(f, "employeeId"), amount: s(f, "amount"), idempotencyKey: key(f) }); },
  "hr.payrollPrepare": async (c, f) => { await hr.preparePayroll(c, s(f, "period"), { advanceRecoveryPerMonth: o(f, "recovery") }); },
  "hr.payrollApprove": async (c, f) => { await hr.approvePayroll(c, s(f, "id")); },
  "hr.payrollPay": async (c, f) => { await hr.payPayroll(c, s(f, "id")); },
  "hr.gratuityPolicy": async (c, f) => { await hr.setGratuityPolicy(c, { firstYearsRate: n(f, "rate1"), firstYears: n(f, "years1"), laterRate: n(f, "rate2"), capMonths: n(f, "cap") }); },

  // ---------- CRM / communications ----------
  "crm.enquiry": async (c, f) => { await crm.createEnquiry(c, { name: s(f, "name"), phone: s(f, "phone"), channel: s(f, "channel"), source: s(f, "source"), interest: o(f, "interest"), note: o(f, "note") }); },
  "crm.enquiryUpdate": async (c, f) => { await crm.updateEnquiry(c, s(f, "id"), { status: o(f, "status") as "contacted" | undefined, note: o(f, "note") }); },
  "crm.followUp": async (c, f) => { await crm.createFollowUp(c, { patientId: s(f, "patientId"), kind: s(f, "kind") as "follow_up", dueAt: dt(f, "due"), note: o(f, "note") }); },
  "crm.followUpDone": async (c, f) => { await crm.completeFollowUp(c, s(f, "id")); },
  "crm.missed": async (c) => { await crm.generateMissedAppointmentFollowUps(c); },
  "crm.campaign": async (c, f) => { await crm.createCampaign(c, { name: s(f, "name"), kind: s(f, "kind") as "recall", channel: s(f, "channel") as "sms", lastVisitBeforeDays: n(f, "days") }); },
  "crm.feedback": async (c, f) => { await crm.submitFeedback(c, { patientId: o(f, "patientId"), rating: n(f, "rating"), nps: on(f, "nps"), comment: o(f, "comment") }); },
  "crm.complaint": async (c, f) => { await crm.fileComplaint(c, { patientId: o(f, "patientId"), category: s(f, "category"), description: s(f, "description") }); },
  "crm.complaintMove": async (c, f) => { await crm.progressComplaint(c, s(f, "id"), s(f, "to") as "resolved", { assignedTo: o(f, "assignedTo"), resolution: o(f, "resolution") }); },
  "comm.template": async (c, f) => { await comm.upsertTemplate(c, { key: s(f, "key"), channel: s(f, "channel") as "sms", language: s(f, "language") as "en", subject: o(f, "subject"), body: s(f, "body"), category: s(f, "category") as "transactional" }); },
  "comm.send": async (c, f) => { await comm.sendMessage(c, { patientId: s(f, "patientId"), templateKey: s(f, "templateKey"), channel: s(f, "channel") as "sms" }); },
  "comm.retry": async (c) => { await comm.retryFailed(c); },
  "comm.reminders": async (c, f) => { await comm.scheduleAppointmentReminders(c, { withinHours: on(f, "hours") ?? 24 }); },
  "comm.optout": async (c, f) => { await comm.recordOptOut(c, s(f, "patientId"), s(f, "channel") as "sms"); },

  // ---------- compliance / integrations ----------
  "comp.licence": async (c, f) => { await comp.addLicence(c, { kind: s(f, "kind") as "facility", holder: s(f, "holder"), authority: s(f, "authority") as "DHA", number: s(f, "number"), expiry: dt(f, "expiry") }); },
  "comp.checklist": async (c, f) => { await comp.addChecklistItem(c, { title: s(f, "title"), authority: s(f, "authority"), dueDate: od(f, "due"), owner: o(f, "owner") }); },
  "comp.checklistStatus": async (c, f) => { await comp.setChecklistStatus(c, s(f, "id"), s(f, "status") as "compliant", o(f, "evidenceId")); },
  "comp.incident": async (c, f) => { await comp.reportIncident(c, { title: s(f, "title"), severity: s(f, "severity") as "low", description: s(f, "description") }); },
  "comp.action": async (c, f) => { await comp.addCorrectiveAction(c, s(f, "incidentId"), { description: s(f, "description"), owner: s(f, "owner"), due: dt(f, "due") }); },
  "comp.actionDone": async (c, f) => { await comp.completeCorrectiveAction(c, s(f, "incidentId"), s(f, "actionId")); },
  "comp.incidentClose": async (c, f) => { await comp.closeIncident(c, s(f, "id"), s(f, "note")); },
  "comp.policy": async (c, f) => { await comp.publishPolicy(c, { title: s(f, "title"), body: s(f, "body") }); },
  "comp.ack": async (c, f) => { await comp.acknowledgePolicy(c, s(f, "id")); },
  "comp.integration": async (c, f) => { await comp.setIntegrationStatus(c, s(f, "key"), s(f, "status") as "specification_reviewed", o(f, "evidence")); },
  "comp.accessReview": async (c, f) => { await comp.completeAccessReview(c, s(f, "note")); },
  "hie.enqueue": async (c, f) => { await hie.enqueueHieMessage(c, { hie: s(f, "hie") as "NABIDH", patientId: s(f, "patientId"), type: s(f, "type") as "ADT_A04" }); },
  "hie.process": async (c) => { await hie.processHieQueue(c); },
  "hie.retryDead": async (c, f) => { await hie.retryDead(c, s(f, "id")); },
  "einv.submit": async (c, f) => { await einv.submitEInvoice(c, { invoiceId: s(f, "invoiceId"), creditNoteId: o(f, "creditNoteId") }); },

  // ---------- finance ----------
  "fin.openRegister": async (c, f) => { await cash.openRegister(c, { openingFloat: s(f, "float") }); },
  "fin.closeRegister": async (c, f) => { await cash.closeRegister(c, { counted: s(f, "counted"), note: o(f, "note") }); },
  "fin.transfer": async (c, f) => { await cash.transferFunds(c, { from: s(f, "from") as "cash", to: s(f, "to") as "bank", amount: s(f, "amount"), idempotencyKey: key(f), memo: o(f, "memo") }); },
  "fin.petty": async (c, f) => { await cash.pettyCashExpense(c, { expenseCode: s(f, "code"), amount: s(f, "amount"), description: s(f, "description"), idempotencyKey: key(f) }); },
  "fin.importBank": async (c, f) => {
    const lines = s(f, "csv").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [date, description, amount, reference] = l.split(",").map((x) => x.trim()); return { date, description, amount, reference }; });
    await cash.importBankStatement(c, { account: s(f, "account") as "bank", lines });
  },
  "fin.autoMatch": async (c, f) => { await cash.autoMatchBank(c, s(f, "account") as "bank"); },
  "fin.card": async (c, f) => { await cash.settleCardBatch(c, { reference: s(f, "reference"), gross: s(f, "gross"), fees: s(f, "fees") || "0" }); },
  "fin.budget": async (c, f) => { await st.setBudget(c, { year: n(f, "year"), accountCode: s(f, "code"), amount: s(f, "amount") }); },
  "fin.journalSubmit": async (c, f) => { await drafts.submitJournalForApproval(c, { date: dt(f, "date"), memo: s(f, "memo"), sourceRef: { type: "manual", id: randomUUID() }, lines: [{ accountId: `${c.orgId}:${s(f, "debitCode")}`, debit: s(f, "amount") }, { accountId: `${c.orgId}:${s(f, "creditCode")}`, credit: s(f, "amount") }] }); },
  "fin.journalDecide": async (c, f) => { await drafts.decideDraftJournal(c, s(f, "id"), s(f, "decision") === "approve", o(f, "reason")); },
  "fin.closePeriod": async (c, f) => { await drafts.closePeriod(c, n(f, "year"), n(f, "month")); },
  "fin.closeYear": async (c, f) => { await drafts.closeFiscalYear(c, n(f, "year")); },

  // ---------- hospital ----------
  "hosp.config": async (c, f) => { await hosp.setHospitalConfig(c, { bedServiceId: o(f, "bedServiceId"), theatreServiceId: o(f, "theatreServiceId"), erThresholdsMinutes: Object.fromEntries([1, 2, 3, 4, 5].filter((l) => on(f, `th${l}`) !== undefined).map((l) => [String(l), on(f, `th${l}`)!])) }); },
  "hosp.ward": async (c, f) => { await hosp.createWard(c, { code: s(f, "code"), name: s(f, "name") }); },
  "hosp.bed": async (c, f) => { await hosp.createBed(c, { wardId: s(f, "wardId"), bedNo: s(f, "bedNo") }); },
  "hosp.admit": async (c, f) => { await hosp.admitPatient(c, { patientId: s(f, "patientId"), bedId: s(f, "bedId"), doctorId: s(f, "doctorId"), reason: s(f, "reason") }); },
  "hosp.transfer": async (c, f) => { await hosp.transferBed(c, s(f, "admissionId"), s(f, "bedId")); },
  "hosp.clean": async (c, f) => { await hosp.markBedClean(c, s(f, "bedId")); },
  "hosp.obs": async (c, f) => { await hosp.recordObservation(c, { admissionId: s(f, "admissionId"), systolic: on(f, "systolic"), diastolic: on(f, "diastolic"), heartRate: on(f, "hr"), spo2: on(f, "spo2"), tempC: on(f, "temp"), note: o(f, "note") }); },
  "hosp.medOrder": async (c, f) => { await hosp.orderInpatientMedication(c, { admissionId: s(f, "admissionId"), itemId: s(f, "itemId"), dose: s(f, "dose"), route: s(f, "route"), everyHours: n(f, "every"), allergyOverride: o(f, "override") }); },
  "hosp.dose": async (c, f) => { await hosp.administerDose(c, s(f, "id"), { status: s(f, "status") as "given", reason: o(f, "reason") }); },
  "hosp.discharge": async (c, f) => { await hosp.dischargePatient(c, s(f, "admissionId"), { summary: s(f, "summary"), disposition: s(f, "disposition") as "home" }); },
  "hosp.erRegister": async (c, f) => { await hosp.registerEr(c, { patientId: o(f, "patientId"), alias: o(f, "alias"), complaint: s(f, "complaint"), arrivalMode: s(f, "mode") || "walk-in" }); },
  "hosp.triage": async (c, f) => { await hosp.triage(c, s(f, "id"), { level: n(f, "level") as 1, note: o(f, "note") }); },
  "hosp.erTeam": async (c, f) => { await hosp.assignErTeam(c, s(f, "id"), { doctorId: o(f, "doctorId"), nurseId: o(f, "nurseId") }); },
  "hosp.erDispose": async (c, f) => { await hosp.disposeEr(c, s(f, "id"), { type: s(f, "type") as "discharge", note: s(f, "note"), receivingFacility: o(f, "facility"), bedId: o(f, "bedId"), doctorId: o(f, "doctorId") }); },
  "hosp.theatre": async (c, f) => { await hosp.createTheatre(c, { code: s(f, "code"), name: s(f, "name") }); },
  "hosp.surgery": async (c, f) => { await hosp.scheduleSurgery(c, { theatreId: s(f, "theatreId"), patientId: s(f, "patientId"), procedure: s(f, "procedure"), surgeonId: s(f, "surgeonId"), start: dt(f, "start"), end: dt(f, "end") }); },
  "hosp.check": async (c, f) => { await hosp.completeChecklistItem(c, s(f, "id"), n(f, "index")); },
  "hosp.consent": async (c, f) => { await hosp.recordSurgeryConsent(c, s(f, "patientId")); },
  "hosp.start": async (c, f) => { await hosp.startSurgery(c, s(f, "id")); },
  "hosp.recovery": async (c, f) => { await hosp.moveToRecovery(c, s(f, "id"), s(f, "notes")); },
  "hosp.recoveryObs": async (c, f) => { await hosp.recordRecoveryObservation(c, s(f, "id"), s(f, "note")); },
  "hosp.complete": async (c, f) => { await hosp.completeSurgery(c, s(f, "id")); },
  "hosp.cancel": async (c, f) => { await hosp.cancelSurgery(c, s(f, "id"), s(f, "reason")); },

  // ---------- specialty ----------
  "spec.tooth": async (c, f) => { await spec.recordTooth(c, { patientId: s(f, "patientId"), tooth: n(f, "tooth"), surface: o(f, "surface"), condition: s(f, "condition"), note: o(f, "note") }); },
  "spec.plan": async (c, f) => { await spec.createTreatmentPlan(c, { patientId: s(f, "patientId"), items: [{ tooth: n(f, "tooth"), serviceId: s(f, "serviceId") }] }); },
  "spec.planDone": async (c, f) => { await spec.completePlanItem(c, s(f, "id"), n(f, "index"), s(f, "encounterId")); },
  "spec.package": async (c, f) => { await spec.sellPackage(c, { patientId: s(f, "patientId"), name: s(f, "name"), sessions: n(f, "sessions"), price: s(f, "price") }); },
  "spec.consume": async (c, f) => { await spec.consumeSession(c, s(f, "id"), o(f, "note")); },
  "spec.growth": async (c, f) => { await spec.recordGrowth(c, { patientId: s(f, "patientId"), date: s(f, "date"), weightKg: n(f, "weight"), heightCm: n(f, "height"), headCm: on(f, "head") }); },
  "spec.vaccine": async (c, f) => { await spec.recordVaccination(c, { patientId: s(f, "patientId"), vaccine: s(f, "vaccine"), dose: n(f, "dose"), date: s(f, "date"), batch: o(f, "batch") }); },
  "spec.measure": async (c, f) => { await spec.recordMeasurement(c, { patientId: s(f, "patientId"), kind: s(f, "kind"), value: n(f, "value"), unit: s(f, "unit") }); },
  "spec.carePlan": async (c, f) => { await spec.setCarePlan(c, { patientId: s(f, "patientId"), condition: s(f, "condition"), intervalDays: n(f, "interval"), kinds: list(f, "kinds") }); },
  "spec.photoConsent": async (c, f) => { await spec.grantPhotoConsent(c, s(f, "patientId")); },

  // ---------- AI (drafts only) ----------
  "ai.dictation": async (c, f) => { await ai.dictationToDraft(c, { encounterId: s(f, "encounterId"), text: s(f, "text") }); },
  "ai.accept": async (c, f) => { await ai.acceptDraft(c, s(f, "id")); },
  "ai.reject": async (c, f) => { await ai.rejectDraft(c, s(f, "id")); },
  "ai.settings": async (c, f) => { await ai.setOrgSettings(c, { openingHours: o(f, "hours"), address: o(f, "address"), phone: o(f, "phone") }); },

  // ---------- portal ----------
  "portal.book": async (c, f) => { await portal.portalBook(c, { doctorId: s(f, "doctorId"), start: dt(f, "start"), end: new Date(dt(f, "start").getTime() + 30 * 60000) }); },
  "portal.cancel": async (c, f) => { await portal.portalCancel(c, s(f, "id"), s(f, "reason")); },
  "portal.intake": async (c, f) => { await portal.portalSubmitIntake(c, { phone: o(f, "phone"), email: o(f, "email"), address: o(f, "address"), commPrefs: { sms: b(f, "sms"), email: b(f, "emailPref"), whatsapp: b(f, "whatsapp"), marketing: b(f, "marketing") }, selfReportedAllergies: list(f, "allergies"), consentToTreatment: b(f, "consent") }); },

  // ---------- preferences / notifications ----------
  "prefs.widgets": async (c, f) => { await prefs.setWidgets(c, f.getAll("widget").map(String)); },
  "prefs.saveView": async (c, f) => { await prefs.saveView(c, { page: s(f, "page") as "patients", name: s(f, "name"), query: s(f, "query") }); },
  "prefs.deleteView": async (c, f) => { await prefs.deleteView(c, s(f, "id")); },
  "notify.readAll": async (c) => { await markAllRead(c); },
};
