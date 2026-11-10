import { tenantCol } from "@/core/db";
import { toDecimal128, money } from "@/core/money";
import { createOrg } from "./service";
import { ensureChartOfAccounts } from "@/modules/ledger/accounts";

export const DEMO_ORG_ID = "demo-dubai-clinic";
export const DEMO_BRANCH_ID = `${DEMO_ORG_ID}:main`;

// Departments follow the clinic's published service lines (www.elistermed.ae).
const DEPARTMENTS = [
  ["GP", "General Medicine", "الطب العام"], ["DERM", "Dermatology", "الأمراض الجلدية"], ["AESTH", "Aesthetic Dermatology", "الجلدية التجميلية"],
  ["DENT", "Dentistry", "طب الأسنان"], ["OBGYN", "OB & Gynaecology", "أمراض النساء والتوليد"], ["PED", "Paediatrics", "طب الأطفال"],
  ["LAB", "Pathology & Laboratory", "علم الأمراض والمختبر"], ["PHARM", "Pharmacy", "الصيدلية"], ["HOME", "Home Care", "الرعاية المنزلية"],
] as const;

export const DEMO_DOCTORS = [
  { userKey: "dr.amina", name: "Dr. Amina Khalid (synthetic)", nameAr: "د. أمينة خالد", dept: "GP", specialty: "General Practice" },
  { userKey: "dr.omar", name: "Dr. Omar Haddad (synthetic)", nameAr: "د. عمر حداد", dept: "DENT", specialty: "Dentistry" },
  { userKey: "dr.layla", name: "Dr. Layla Nasser (synthetic)", nameAr: "د. ليلى ناصر", dept: "DERM", specialty: "Dermatology" },
] as const;

// Prices are synthetic. Tax: conservative STD until a UAE tax professional reviews each service.
export const DEMO_SERVICES = [
  { code: "CONS-GP", name: "GP Consultation", dept: "GP", kind: "consultation", price: "250.00", rev: "rev_consultation", consultation: true },
  { code: "CONS-DENT", name: "Dental Consultation", dept: "DENT", kind: "consultation", price: "200.00", rev: "rev_dental", consultation: true },
  { code: "CONS-DERM", name: "Dermatology Consultation", dept: "DERM", kind: "consultation", price: "350.00", rev: "rev_consultation", consultation: true },
  { code: "CONS-FU", name: "Follow-up Consultation", dept: "GP", kind: "consultation", price: "150.00", rev: "rev_consultation", consultation: false },
  { code: "PROC-SCALE", name: "Dental Scaling and Polish", dept: "DENT", kind: "procedure", price: "400.00", rev: "rev_dental", consultation: false },
  { code: "PROC-DRESS", name: "Wound Dressing", dept: "GP", kind: "procedure", price: "120.00", rev: "rev_procedure", consultation: false },
  { code: "LAB-CBC", name: "Complete Blood Count", dept: "LAB", kind: "lab", price: "90.00", rev: "rev_laboratory", consultation: false },
  { code: "CONS-PED", name: "Paediatric Consultation", dept: "PED", kind: "consultation", price: "200.00", rev: "rev_consultation", consultation: true },
  { code: "CONS-OBGYN", name: "OB & Gynaecology Consultation", dept: "OBGYN", kind: "consultation", price: "300.00", rev: "rev_consultation", consultation: true },
  { code: "CONS-AESTH", name: "Aesthetic Dermatology Consultation", dept: "AESTH", kind: "consultation", price: "400.00", rev: "rev_consultation", consultation: true },
] as const;

export async function seedOrg(): Promise<{ orgId: string; branchId: string }> {
  const orgId = DEMO_ORG_ID;
  const existing = await tenantCol(orgId, "orgs").findOne({ _id: orgId } as never);
  if (!existing) {
    await createOrg({
      name: "Elister Med", facilityType: "polyclinic", jurisdiction: "DHA",
      modules: { insurance: true, pharmacy: true, laboratory: true, inventory: true, hr: true, hospital: false },
    }, orgId);
  }
  // Public contact details of the clinic, as published on its website. Patients, staff and all clinical data in this system are synthetic.
  await tenantCol(orgId, "orgs").updateOne({ _id: orgId } as never, { $set: {
    nameAr: "اليستر ميد", tagline: "Your Trusted Family Healthcare Partner in Dubai", website: "www.elistermed.ae", email: "info@elistermed.ae",
    phone: "+971 4 283 8398", address: "Al Noor Building, Al Qusais Industrial Area 3, Al Qusais, Dubai",
  } } as never);
  const up = <T extends object>(name: string, filter: object, doc: T) =>
    tenantCol(orgId, name).updateOne(filter as never, { $setOnInsert: doc } as never, undefined, { upsert: true });

  await up("branches", { code: "MAIN" }, { _id: DEMO_BRANCH_ID, code: "MAIN", name: "Al Qusais, Dubai", emirate: "Dubai", address: "Al Noor Building, Al Qusais Industrial Area 3", active: true });
  for (const [code, name, nameAr] of DEPARTMENTS) await up("departments", { code }, { _id: `${orgId}:${code}`, code, name, nameAr, active: true });

  for (const [code, rate, kind] of [["STD", "5", "standard"], ["ZERO", "0", "zero"], ["EXEMPT", "0", "exempt"]] as const)
    await up("tax_codes", { code }, { _id: `${orgId}:${code}`, code, rate: toDecimal128(money(rate)), kind, reviewRequired: true });

  for (const d of DEMO_DOCTORS)
    await up("staff", { userKey: d.userKey }, {
      _id: `${orgId}:${d.userKey}`, userKey: d.userKey, name: d.name, nameAr: d.nameAr, departmentId: `${orgId}:${d.dept}`,
      branchId: DEMO_BRANCH_ID, specialty: d.specialty, role: "doctor", slotMinutes: 20,
      workDays: [1, 2, 3, 4, 5], workStart: "09:00", workEnd: "17:00", active: true,
    });

  for (const s of DEMO_SERVICES)
    await up("services", { code: s.code }, {
      _id: `${orgId}:${s.code}`, code: s.code, name: s.name, departmentId: `${orgId}:${s.dept}`, kind: s.kind,
      price: toDecimal128(money(s.price)), taxCode: "STD", taxReviewRequired: true, revenueAccountSystem: s.rev,
      isDefaultConsultation: s.consultation, active: true,
    });

  await ensureChartOfAccounts(orgId);

  for (const year of [2026, 2027]) for (let m = 1; m <= 12; m++)
    await up("fiscal_periods", { year, month: m }, {
      _id: `${orgId}:${year}-${m}`, year, month: m, status: "open",
      start: new Date(Date.UTC(year, m - 1, 1, -4)), end: new Date(Date.UTC(year, m, 1, -4)),
    });

  return { orgId, branchId: DEMO_BRANCH_ID };
}
