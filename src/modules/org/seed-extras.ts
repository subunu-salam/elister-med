import { tenantCol } from "@/core/db";
import { toDecimal128, money } from "@/core/money";

/**
 * Synthetic demo content for the optional modules. Everything is clearly fictional, idempotent, and uses only
 * deterministic ids, so running the seed twice changes nothing. No stock is seeded: receive it through Procurement
 * so the ledger and inventory stay reconciled.
 */
export async function seedExtras(orgId: string): Promise<void> {
  const up = (name: string, filter: object, doc: object) => tenantCol(orgId, name).updateOne(filter as never, { $setOnInsert: doc } as never, undefined, { upsert: true });
  const id = (k: string) => `${orgId}:${k}`;

  await tenantCol(orgId, "orgs").updateOne({ _id: orgId } as never, { $set: { trn: "100000000000003" } } as never); // synthetic TRN for demo validation

  await up("payers", { code: "SBI" }, { _id: id("payer:SBI"), name: "Sandbox Insurer (synthetic)", code: "SBI", kind: "insurer", active: true });
  await up("plans", { name: "Gold (synthetic)" }, { _id: id("plan:gold"), payerId: id("payer:SBI"), name: "Gold (synthetic)", copayPct: 20, copayCapPerVisit: toDecimal128(money("50.00")), preauthServiceCodes: ["PROC-SCALE"], exclusions: [], active: true });

  await up("suppliers", { name: "MedSupply LLC (synthetic)" }, { _id: id("supplier:medsupply"), name: "MedSupply LLC (synthetic)", termsDays: 30, active: true });

  for (const i of [
    { sku: "PARA-500", name: "Paracetamol 500mg", genericName: "paracetamol", category: "medicine", strength: "500 mg", form: "tablet", price: "5.00", reorderLevel: 50, reorderQty: 200 },
    { sku: "AMOX-500", name: "Amoxicillin 500mg", genericName: "amoxicillin", category: "medicine", strength: "500 mg", form: "capsule", price: "25.00", reorderLevel: 30, reorderQty: 100 },
    { sku: "GLOVE-M", name: "Examination gloves (box)", category: "consumable", price: undefined, reorderLevel: 10, reorderQty: 40 },
  ] as const)
    await up("inv_items", { sku: i.sku }, { _id: id(`item:${i.sku}`), sku: i.sku, name: i.name, genericName: (i as { genericName?: string }).genericName, category: i.category, uom: "unit", reorderLevel: i.reorderLevel, reorderQty: i.reorderQty, ...(i.price ? { sellingPrice: toDecimal128(money(i.price)) } : {}), taxCode: "STD", controlled: false, strength: (i as { strength?: string }).strength, form: (i as { form?: string }).form, active: true });

  // Reference ranges are intentionally NOT provided: the laboratory must configure and approve them.
  await up("lab_tests", { code: "HGB" }, { _id: id("labtest:HGB"), code: "HGB", name: "Haemoglobin", loinc: "718-7", specimen: "Whole blood", unit: "g/dL", ranges: [], serviceId: id("LAB-CBC"), active: true });
  await up("lab_tests", { code: "GLU" }, { _id: id("labtest:GLU"), code: "GLU", name: "Glucose (fasting)", loinc: "1558-6", specimen: "Serum", unit: "mmol/L", ranges: [], active: true });

  await up("comm_templates", { key: "appointment_reminder", channel: "sms", language: "en" }, { _id: id("tpl:reminder:en"), key: "appointment_reminder", channel: "sms", language: "en", body: "Reminder: {{patientName}}, you have an appointment on {{appointmentTime}} with {{doctorName}} at {{clinicName}}.", category: "transactional", active: true });
  await up("comm_templates", { key: "appointment_reminder", channel: "sms", language: "ar" }, { _id: id("tpl:reminder:ar"), key: "appointment_reminder", channel: "sms", language: "ar", body: "تذكير: {{patientName}}، لديك موعد في {{appointmentTime}} مع {{doctorName}} في {{clinicName}}.", category: "transactional", active: true });
  await up("comm_templates", { key: "results_ready", channel: "in_app", language: "en" }, { _id: id("tpl:results:en"), key: "results_ready", channel: "in_app", language: "en", body: "Your results are available in the portal.", category: "transactional", active: true });
}
