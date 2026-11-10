/**
 * Demo activity for the synthetic clinic. It drives the REAL services (the same code paths the UI uses), so every invoice,
 * payment and ledger entry here is genuine and balanced; nothing is inserted behind the ledger's back. All people are fictional.
 * Idempotent: a marker document stops a second run.
 */
import { tenantCol } from "../src/core/db";
import { getDb } from "../src/core/db";
import { permissionsFor, type RoleKey } from "../src/core/rbac/roles";
import type { Ctx } from "../src/core/rbac/authorize";
import { createPatient } from "../src/modules/patients/service";
import { bookAppointment } from "../src/modules/appointments/service";
import { checkIn } from "../src/modules/queue/service";
import { openEncounter, recordVitals, addDiagnosis, saveDraftNote, signNote, completeEncounter } from "../src/modules/emr/service";
import { listUnbilledCharges } from "../src/modules/billing/charges";
import { finalizeInvoice } from "../src/modules/billing/invoice";
import { recordPayment } from "../src/modules/billing/payment";
import { createPolicy, recordEligibility, listPayers, listPlans } from "../src/modules/insurance/masters";
import { finalizeInsuredInvoice, validateClaim, submitClaim, recordPayerResponse } from "../src/modules/insurance/claims";

const mk = (roles: RoleKey[], userId: string, orgId: string, branchId: string): Ctx => ({ userId, orgId, branchId, roles, permissions: permissionsFor(roles) });

const PEOPLE: [string, string, "male" | "female"][] = [
  ["Fatima Al Mazrouei", "fatima", "female"], ["Ahmed Al Suwaidi", "ahmed", "male"], ["Maryam Khan", "maryam", "female"], ["Omar Siddiqui", "omar", "male"],
  ["Sara Thomas", "sara", "female"], ["Rashid Al Falasi", "rashid", "male"], ["Aisha Rahman", "aisha", "female"], ["Yousef Nair", "yousef", "male"],
  ["Layla Haddad", "layla", "female"], ["Hamdan Al Ketbi", "hamdan", "male"], ["Noor Fernandes", "noor", "female"], ["Khalid Ibrahim", "khalid", "male"],
  ["Priya Menon", "priya", "female"], ["Zayed Al Nuaimi", "zayed", "male"], ["Hana Kobeissi", "hana", "female"], ["Salem Al Ali", "salem", "male"],
];
const DX: Record<string, [string, string][]> = {
  GP: [["J06.9", "Acute upper respiratory infection"], ["R51", "Headache"], ["I10", "Essential hypertension"]],
  DENT: [["K02.9", "Dental caries, unspecified"], ["K05.1", "Chronic gingivitis"]],
  DERM: [["L70.0", "Acne vulgaris"], ["L20.9", "Atopic dermatitis, unspecified"]],
};
const SOAP = { s: "Presented with the reported complaint for several days.", o: "Examination unremarkable apart from the finding noted.", a: "Assessment recorded by the clinician.", p: "Treatment advised and follow-up arranged." };

function lastWorkday(): string {
  const d = new Date(Date.now() + 4 * 3600_000);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function seedActivity(orgId: string, branchId: string): Promise<void> {
  const db = await getDb();
  if (await db.collection("seed_markers").findOne({ orgId, key: "demo-activity" })) return;

  const reg = mk(["receptionist"], "seed-reception", orgId, branchId);
  const coord = mk(["insurance_coordinator"], "seed-insurance", orgId, branchId);
  const docs = await tenantCol<{ _id: string; userId?: string; departmentId: string }>(orgId, "staff").find({ role: "doctor", active: true } as never);
  const deptCode = (id: string) => id.split(":").pop()!;
  const day = lastWorkday();
  const at = (i: number) => new Date(`${day}T${String(9 + Math.floor((i * 20) / 60)).padStart(2, "0")}:${String((i * 20) % 60).padStart(2, "0")}:00+04:00`);

  const slot: Record<string, number> = {};
  let n = 0;
  for (const [name, key, sex] of PEOPLE) {
    const doc = docs[n % docs.length];
    if (!doc?.userId) break;
    const docCtx = mk(["doctor"], doc.userId, orgId, branchId);
    const i = (slot[doc._id] = (slot[doc._id] ?? 0) + 1) - 1;
    const p = await createPatient(reg, {
      fullName: name, dob: `${1960 + (n * 7) % 45}-0${1 + (n % 9)}-1${n % 9}`, sex, phone: `+97155${String(2100000 + n * 137)}`, nationality: n % 3 === 0 ? "UAE" : n % 3 === 1 ? "India" : "Lebanon",
      email: `${key}@example.org`, referralSource: ["instagram", "walk-in", "referral", "google"][n % 4], preferredLanguage: n % 4 === 0 ? "ar" : "en",
      consents: [{ type: "treatment", granted: true, at: new Date() }],
    });
    const appt = await bookAppointment(reg, { patientId: p._id, doctorId: doc._id, start: at(i), end: new Date(at(i).getTime() + 20 * 60000) });

    if (n === 13 || n === 14) { n++; continue; }                                  // two upcoming appointments stay booked
    if (n === 15) { await checkIn(reg, appt._id); n++; continue; }                  // one patient still waiting
    await checkIn(reg, appt._id);
    const w = await openEncounter(docCtx, appt._id);
    await recordVitals(docCtx, w.encounter._id, { systolic: 112 + (n % 5) * 4, diastolic: 72 + (n % 4) * 3, heartRate: 68 + (n % 6) * 3, tempC: 36.6 });
    const [code, description] = DX[deptCode(doc.departmentId)]?.[n % (DX[deptCode(doc.departmentId)]?.length ?? 1)] ?? DX.GP[0];
    await addDiagnosis(docCtx, w.encounter._id, { code, description, primary: true });
    await saveDraftNote(docCtx, w.note._id, SOAP);
    await signNote(docCtx, w.note._id);
    await completeEncounter(docCtx, w.encounter._id);

    if (n === 4) continue;                                                            // insured visit handled below
    const charges = await listUnbilledCharges(reg, p._id);
    if (!charges.length) { n++; continue; }
    const inv = await finalizeInvoice(reg, { patientId: p._id, chargeIds: charges.map((c) => c._id) });
    if (n % 5 === 3) { n++; continue; }                                               // left unpaid: receivable
    const total = Number(inv.total.toString());
    const method = (["cash", "card", "card", "bank"] as const)[n % 4];
    const part = n % 7 === 2;                                                         // one partial payment
    await recordPayment(reg, { invoiceId: inv._id, method, amount: (part ? total / 2 : total).toFixed(2), idempotencyKey: `seed-pay-${n}` });
    n++;
  }

  // One insured visit taken all the way to a submitted (sandbox) claim.
  const insured = await tenantCol<{ _id: string }>(orgId, "patients").find({ fullName: "Sara Thomas" } as never);
  const payers = await listPayers(coord), plans = await listPlans(coord);
  if (insured[0] && payers[0] && plans[0]) {
    const pid = insured[0]._id;
    const policy = await createPolicy(coord, { patientId: pid, planId: plans[0]._id, memberNo: "SBI-0001", startDate: new Date(Date.now() - 90 * 86400000), endDate: new Date(Date.now() + 270 * 86400000) });
    await recordEligibility(coord, { patientId: pid, policyId: policy._id, result: "eligible", source: "manual", reference: "DEMO-VERIFIED" });
    const charges = await listUnbilledCharges(reg, pid);
    if (charges.length) {
      const r = await finalizeInsuredInvoice(coord, { patientId: pid, chargeIds: charges.map((c) => c._id), policyId: policy._id });
      const v = await validateClaim(coord, r.claim._id);
      if (!v.errors.length) { await submitClaim(coord, r.claim._id); await recordPayerResponse(coord, r.claim._id, { outcome: "accepted" }); }
    }
  }
  await db.collection("seed_markers").insertOne({ orgId, key: "demo-activity", at: new Date() });
}
