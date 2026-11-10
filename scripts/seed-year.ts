/**
 * One year of Elister Med (Al Qusais, Dubai) activity, from 2025-11-03 to yesterday.
 *
 * Everything is driven through the REAL services (same code paths as the UI) under a simulated clock, so invoices, payments, claims, stock,
 * payroll and the double-entry ledger are genuine, dated and balanced. Patients, staff and suppliers are fictional; insurers, regulators,
 * places, drug names and ICD-10 codes are real. Builds into a throw-away in-memory replica set, verifies the books, then exports to
 * .seed-cache/year/ so `npm run seed:year:push` can load it into Atlas (see scripts/seed-year-push.ts).
 *
 *   npm run seed:year            full year
 *   SEED_DAYS=10 npm run seed:year   quick dry run
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import fs from "node:fs";
import path from "node:path";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { BSON } from "mongodb";
import { installClock, setNow, advance, nowMs, RealDate, uninstallClock } from "./year/clock";
import * as D from "./year/data";

const ORG = "demo-dubai-clinic";
const BRANCH = `${ORG}:main`;
const START = "2025-11-03";
const SCALE = Number(process.env.SEED_SCALE ?? 1);
const MAX_DAYS = process.env.SEED_DAYS ? Number(process.env.SEED_DAYS) : Infinity;
const rng = D.mulberry32(20251103);
const R = () => rng();
const pick = <T,>(a: readonly T[]): T => a[Math.floor(R() * a.length)];
const between = (a: number, b: number) => a + Math.floor(R() * (b - a + 1));
const chance = (p: number) => R() < p;
const gauss = () => { let u = 0, v = 0; while (!u) u = R(); while (!v) v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const weighted = <T,>(items: readonly [T, number][]): T => { const t = items.reduce((a, b) => a + b[1], 0); let x = R() * t; for (const [v, w] of items) { if ((x -= w) < 0) return v; } return items[items.length - 1][0]; };
const pad = (n: number) => String(n).padStart(2, "0");
const r2 = (n: number) => Math.round(n * 100) / 100;

const errors: Record<string, { n: number; sample: string }> = {};
async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn(); } catch (e) {
    const m = (e as Error).message ?? String(e);
    errors[label] ??= { n: 0, sample: m.slice(0, 220) };
    errors[label].n++;
    return undefined;
  }
}

// ---------- calendar ----------
const ymdAdd = (ymd: string, days: number) => { const d = new RealDate(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const dowOf = (ymd: string) => new RealDate(`${ymd}T00:00:00Z`).getUTCDay();
const at = (ymd: string, hh: number, mm = 0) => new Date(`${ymd}T${pad(hh)}:${pad(mm)}:00+04:00`);
const dubaiYmd = (d: Date) => new RealDate(d.getTime() + 4 * 3600_000).toISOString().slice(0, 10);

// UAE public holidays in the window (clinic closed). Islamic dates follow the moon-sighting announcements; these are the expected dates.
const HOLIDAYS: Record<string, string> = {
  "2025-12-01": "Commemoration Day", "2025-12-02": "UAE National Day", "2025-12-03": "UAE National Day",
  "2026-01-01": "New Year's Day", "2026-03-20": "Eid Al Fitr", "2026-03-21": "Eid Al Fitr", "2026-03-22": "Eid Al Fitr",
  "2026-05-26": "Arafat Day", "2026-05-27": "Eid Al Adha", "2026-05-28": "Eid Al Adha", "2026-05-29": "Eid Al Adha",
  "2026-06-16": "Islamic New Year", "2026-08-25": "Prophet Muhammad's Birthday",
};
const RAMADAN = ["2026-02-18", "2026-03-19"];
const SEASON = [1.1, 1.05, 0.95, 1.0, 0.95, 0.85, 0.72, 0.76, 1.0, 1.1, 1.05, 1.0]; // Jan..Dec: winter peak, Ramadan dip, summer travel dip
const DOW_FACTOR: Record<number, number> = { 0: 0, 1: 1.05, 2: 1.0, 3: 1.0, 4: 1.0, 5: 0.7, 6: 0.95 };

// ---------- context ----------
import type { RoleKey } from "../src/core/rbac/roles";
import type { Ctx } from "../src/core/rbac/authorize";
async function main() {
  const targetEnv = { MONGODB_URI: process.env.MONGODB_URI, MONGODB_DB: process.env.MONGODB_DB };
  void targetEnv;
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  Object.assign(process.env, {
    MONGODB_URI: rs.getUri(), MONGODB_DB: "healthos_year",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "local-dev-secret-local-dev-secret-0123456789",
    BETTER_AUTH_URL: "http://localhost:3000",
    FIELD_ENCRYPTION_KEY: process.env.FIELD_ENCRYPTION_KEY ?? Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
    DISPLAY_KEY: process.env.DISPLAY_KEY ?? "local-display-key",
  });
  delete process.env.TEST_MONGODB_URI;

  const t0 = Date.now();
  const { permissionsFor } = await import("../src/core/rbac/roles");
  const { getDb, closeClient, tenantCol, ensureIndexes } = await import("../src/core/db");
  const { seedAll } = await import("./seed");
  const mk = (roles: RoleKey[], userId: string): Ctx => ({ userId, orgId: ORG, branchId: BRANCH, roles, permissions: permissionsFor(roles) });
  await seedAll();                                   // real clock: org, departments, doctors, demo users
  const db = await getDb();
  await ensureIndexes();

  const { toDecimal128, money, fromDecimal128 } = await import("../src/core/money");
  const { createPatient } = await import("../src/modules/patients/service");
  const { bookAppointment, cancelAppointment, markNoShow } = await import("../src/modules/appointments/service");
  const { checkIn } = await import("../src/modules/queue/service");
  const E = await import("../src/modules/emr/service");
  const { addCharge, listUnbilledCharges } = await import("../src/modules/billing/charges");
  const { finalizeInvoice } = await import("../src/modules/billing/invoice");
  const { recordPayment } = await import("../src/modules/billing/payment");
  const INS = await import("../src/modules/insurance/masters");
  const CL = await import("../src/modules/insurance/claims");
  const RX = await import("../src/modules/pharmacy/service");
  const LAB = await import("../src/modules/laboratory/service");
  const RAD = await import("../src/modules/radiology/service");
  const INV = await import("../src/modules/inventory/service");
  const PRO = await import("../src/modules/procurement/service");
  const HR = await import("../src/modules/hr/service");
  const CRM = await import("../src/modules/crm/service");
  const COM = await import("../src/modules/communications/service");
  const CB = await import("../src/modules/finance/cashbank");
  const { postJournal } = await import("../src/modules/ledger/journal");
  const CMP = await import("../src/modules/compliance/service");

  // staff accounts (userId only needs to be stable; doctors use their real seeded user ids)
  const rec1 = mk(["receptionist"], "seed-reception-am"), rec2 = mk(["receptionist"], "seed-reception-pm");
  const coord = mk(["insurance_coordinator"], "seed-insurance"), pharm = mk(["pharmacist"], "seed-pharmacist");
  const lab1 = mk(["lab_technician"], "seed-lab1"), lab2 = mk(["lab_technician"], "seed-lab2");
  const rad1 = mk(["radiologist"], "seed-rad1"), rad2 = mk(["radiologist"], "seed-rad2");
  const director = mk(["medical_director"], "seed-director"), fm = mk(["finance_manager"], "seed-finance"), acct = mk(["accountant"], "seed-accountant");
  const hr = mk(["hr_manager"], "seed-hr"), admin = mk(["org_admin"], "seed-admin"), buyer = mk(["accountant"], "seed-buyer"), mgr = mk(["clinic_manager"], "seed-manager");
  const invMgr = mk(["inventory_manager"], "seed-inventory");

  // ---------- master data: staff, services, accounts, holidays ----------
  const upsert = (name: string, filter: object, doc: object) => tenantCol(ORG, name).updateOne(filter as never, { $setOnInsert: doc } as never, undefined, { upsert: true });
  await db.collection("staff").updateMany({ orgId: ORG, role: "doctor" }, { $set: { workDays: [1, 2, 3, 4, 5, 6], workStart: "09:00", workEnd: "21:00" } });
  for (const s of await tenantCol<{ _id: string; name: string }>(ORG, "staff").find({})) if (s.name.includes("(synthetic)")) await db.collection("staff").updateOne({ _id: s._id as never }, { $set: { name: s.name.replace(" (synthetic)", "") } });
  for (const d of D.NEW_DOCTORS)
    await upsert("staff", { userKey: d.userKey }, { _id: `${ORG}:${d.userKey}`, userKey: d.userKey, userId: `seed-dr-${d.userKey.split(".")[1]}`, name: d.name, nameAr: d.nameAr, departmentId: `${ORG}:${d.dept}`, branchId: BRANCH, specialty: d.specialty, role: "doctor", slotMinutes: 20, workDays: d.days, workStart: "09:00", workEnd: "21:00", active: true });
  type Staff = { _id: string; userKey: string; userId: string; name: string; departmentId: string };
  for (const d of [...D.NEW_DOCTORS.map((x) => [x.userKey, x.licence] as const), ...Object.entries(D.DOCTOR_LICENCES)]) await db.collection("staff").updateOne({ orgId: ORG, userKey: d[0] }, { $set: { licenceNo: d[1] } });
  const staff = await tenantCol<Staff>(ORG, "staff").find({ role: "doctor" } as never);
  const docByDept: Record<string, Staff[]> = {};
  for (const s of staff) (docByDept[s.departmentId.split(":").pop()!] ??= []).push(s);
  const docCtx = (s: Staff) => mk(["doctor"], s.userId);

  for (const [code, name, type, normal, system] of [["4250", "Radiology Revenue", "income", "credit", "rev_radiology"], ["4500", "Aesthetic Revenue", "income", "credit", "rev_aesthetic"]] as const)
    await upsert("accounts", { code }, { _id: `${ORG}:${code}`, code, name, type, normal, system, active: true });
  for (const s of D.NEW_SERVICES) await upsert("services", { code: s.code }, { _id: `${ORG}:${s.code}`, code: s.code, name: s.name, departmentId: `${ORG}:${s.dept}`, kind: s.kind, price: toDecimal128(money(s.price)), taxCode: s.tax, taxReviewRequired: true, revenueAccountSystem: s.rev, isDefaultConsultation: false, active: true });
  for (const [code, tax] of Object.entries(D.EXISTING_SERVICE_TAX)) await db.collection("services").updateOne({ orgId: ORG, code }, { $set: { taxCode: tax, taxReviewRequired: true } });
  await db.collection("services").updateOne({ orgId: ORG, code: "CONS-OBGYN" }, { $set: { revenueAccountSystem: "rev_consultation" } });
  await db.collection("orgs").updateOne({ _id: ORG as never }, { $set: { licenseNo: "DHA-F-0083721", legalName: "Elister Medical Center L.L.C" } });
  const svcId = (code: string) => `${ORG}:${code}`;

  // fiscal periods for 2025 (seedOrg creates 2026/2027)
  for (let m = 1; m <= 12; m++) await upsert("fiscal_periods", { year: 2025, month: m }, { _id: `${ORG}:2025-${m}`, year: 2025, month: m, status: "open", start: new Date(Date.UTC(2025, m - 1, 1, -4)), end: new Date(Date.UTC(2025, m, 1, -4)) });

  const END = (() => { const t = dubaiYmd(new RealDate()); return ymdAdd(t, -1); })();
  const TODAY = ymdAdd(END, 1);
  const closed = new Set<string>();
  for (let d = START; d <= END; d = ymdAdd(d, 1)) if (dowOf(d) === 0 || HOLIDAYS[d]) closed.add(d);
  for (const [d, reason] of Object.entries(HOLIDAYS)) await tenantCol(ORG, "time_off").insertOne({ _id: `${ORG}:hol:${d}`, doctorId: null, start: at(d, 0), end: at(ymdAdd(d, 1), 0), reason, kind: "holiday" } as never);
  const LEAVES: Record<string, [string, string]> = { "dr.amina": ["2026-07-06", "2026-07-19"], "dr.omar": ["2026-08-03", "2026-08-16"], "dr.layla": ["2026-07-20", "2026-08-02"], "dr.imran": ["2026-08-10", "2026-08-23"], "dr.nadia": ["2026-06-22", "2026-07-05"] };
  const onLeave = (s: Staff, day: string) => { const l = LEAVES[s.userKey]; return !!l && day >= l[0] && day <= l[1]; };
  for (const [k, [a, b]] of Object.entries(LEAVES)) await tenantCol(ORG, "time_off").insertOne({ _id: `${ORG}:leave:${k}`, doctorId: `${ORG}:${k}`, start: at(a, 0), end: at(ymdAdd(b, 1), 0), reason: "Annual leave", kind: "leave" } as never);

  // ---------- catalogues: inventory, lab, insurance, suppliers ----------
  const itemId = new Map<string, string>();
  for (const it of D.ITEMS) {
    const exists = await db.collection("inv_items").findOne({ orgId: ORG, sku: it.sku });
    const fields = { name: it.name, genericName: it.generic, category: it.category, strength: it.strength, form: it.form, reorderLevel: it.level, reorderQty: it.qty, taxCode: it.category === "medicine" ? "ZERO" : "STD", ...(it.price ? { sellingPrice: toDecimal128(money(it.price.toFixed(2))) } : {}) };
    if (exists) { await db.collection("inv_items").updateOne({ _id: exists._id }, { $set: fields }); itemId.set(it.sku, exists._id as unknown as string); }
    else {
      const c = await INV.createItem(invMgr, { sku: it.sku, name: it.name, genericName: it.generic, category: it.category, strength: it.strength, form: it.form, reorderLevel: it.level, reorderQty: it.qty, sellingPrice: it.price?.toFixed(2), taxCode: fields.taxCode, controlled: false });
      itemId.set(it.sku, c._id);
    }
  }
  const itemBySku = new Map(D.ITEMS.map((i) => [i.sku, i]));

  const testId = new Map<string, string>();
  for (const t of D.LAB_TESTS) {
    const ex = await db.collection("lab_tests").findOne({ orgId: ORG, code: t.code });
    if (ex) { await db.collection("lab_tests").updateOne({ _id: ex._id }, { $set: { name: t.name, loinc: t.loinc, specimen: t.specimen, unit: t.unit, ranges: t.ranges, serviceId: svcId(t.serviceCode) } }); testId.set(t.code, ex._id as unknown as string); }
    else { const c = await LAB.createLabTest(lab1, { code: t.code, name: t.name, loinc: t.loinc, specimen: t.specimen, unit: t.unit, ranges: t.ranges, serviceId: svcId(t.serviceCode) }); testId.set(t.code, c._id); }
    await LAB.approveRanges(director, testId.get(t.code)!);
  }
  const labDef = new Map(D.LAB_TESTS.map((t) => [t.code, t]));

  await db.collection("payers").updateOne({ orgId: ORG, code: "SBI" }, { $set: { active: false } });
  const payerId = new Map<string, string>(), planId = new Map<string, string>();
  for (const [k, p] of Object.entries(D.PAYERS)) payerId.set(k, (await INS.createPayer(coord, { name: p.name, code: k, kind: p.kind }))._id);
  for (const p of D.PLANS) {
    const excl = ["AES-BOTOX", "AES-FILLER", "AES-PEEL", "AES-HYDRA", "AES-LASER", "AES-MESO", "DENT-WHITE", "SVC-IVD", ...(p.noDental ? ["CONS-DENT", "DENT-XRAY", "DENT-FILL", "DENT-EXT", "DENT-SURGEXT", "DENT-RCT", "DENT-CROWN", "PROC-SCALE"] : [])];
    planId.set(p.key, (await INS.createPlan(coord, { payerId: payerId.get(p.payer)!, name: p.name, copayPct: p.copay, copayCapPerVisit: p.cap, preauthServiceCodes: ["DENT-RCT", "DENT-SURGEXT", "DERM-BIOPSY"], exclusions: excl }))._id);
  }
  const planDef = new Map(D.PLANS.map((p) => [p.key, p]));
  const supplierId = new Map<string, string>();
  for (const [k, s] of Object.entries(D.SUPPLIERS)) supplierId.set(k, (await PRO.createSupplier(buyer, { name: s.name, trn: s.trn, termsDays: s.terms }))._id);

  // ---------- HR ----------
  setNow(at(START, 8)); installClock(); setNow(at(START, 8));
  await HR.setHrConfig(hr, { standardDailyHours: 8, overtimeMultiplier: 1.25, workingDaysPerMonth: 30 });
  await HR.setGratuityPolicy(hr, { firstYearsRate: 21, firstYears: 5, laterRate: 30, capMonths: 24 });
  await HR.defineLeaveType(fm, { code: "ANNUAL", name: "Annual leave", daysPerYear: 30, paid: true });
  await HR.defineLeaveType(fm, { code: "SICK", name: "Sick leave", daysPerYear: 90, paid: true });
  await HR.defineLeaveType(fm, { code: "UNPAID", name: "Unpaid leave", daysPerYear: 30, paid: false });
  type Emp = { key: string; name: string; role: string; basic: number; housing: number; transport: number; ot: boolean; join: string; auth: "DHA" | null; id?: string };
  const EMPS: Emp[] = [
    { key: "dr.amina", name: "Dr. Amina Khalid", role: "General Practitioner", basic: 12000, housing: 7000, transport: 3000, ot: false, join: "2024-02-01", auth: "DHA" },
    { key: "dr.omar", name: "Dr. Omar Haddad", role: "Dentist", basic: 15000, housing: 8000, transport: 3000, ot: false, join: "2024-02-01", auth: "DHA" },
    { key: "dr.layla", name: "Dr. Layla Nasser", role: "Dermatologist", basic: 16000, housing: 9000, transport: 3000, ot: false, join: "2024-04-15", auth: "DHA" },
    { key: "dr.imran", name: "Dr. Imran Qureshi", role: "Paediatrician", basic: 13000, housing: 8000, transport: 3000, ot: false, join: "2024-09-01", auth: "DHA" },
    { key: "dr.nadia", name: "Dr. Nadia Farouk", role: "Obstetrician & Gynaecologist", basic: 16000, housing: 9000, transport: 3000, ot: false, join: "2025-01-10", auth: "DHA" },
    { key: "mgr", name: "Reem Al Hammadi", role: "Clinic Manager", basic: 11000, housing: 6000, transport: 2000, ot: false, join: "2024-01-15", auth: null },
    { key: "acc", name: "Joseph Mathew", role: "Accountant", basic: 5500, housing: 2500, transport: 1000, ot: false, join: "2024-03-01", auth: null },
    { key: "rec1", name: "Maria Santos", role: "Receptionist", basic: 3200, housing: 1600, transport: 800, ot: true, join: "2024-05-01", auth: null },
    { key: "rec2", name: "Nusrat Jahan", role: "Receptionist", basic: 3200, housing: 1600, transport: 800, ot: true, join: "2024-08-12", auth: null },
    { key: "nur1", name: "Anitha Varghese", role: "Registered Nurse", basic: 4800, housing: 2600, transport: 1000, ot: true, join: "2024-02-01", auth: "DHA" },
    { key: "nur2", name: "Jocelyn Reyes", role: "Registered Nurse", basic: 4800, housing: 2600, transport: 1000, ot: true, join: "2024-06-10", auth: "DHA" },
    { key: "dna", name: "Sherin Thomas", role: "Dental Assistant", basic: 3800, housing: 2000, transport: 800, ot: true, join: "2024-07-01", auth: null },
    { key: "pha", name: "Imran Hussain", role: "Pharmacist", basic: 7000, housing: 4000, transport: 1500, ot: false, join: "2024-03-15", auth: "DHA" },
    { key: "lab", name: "Kavitha Nair", role: "Laboratory Technician", basic: 4800, housing: 2600, transport: 1000, ot: true, join: "2024-04-01", auth: "DHA" },
    { key: "pro", name: "Rashid Al Ketbi", role: "PRO / HR Officer", basic: 3600, housing: 2000, transport: 800, ot: false, join: "2024-01-20", auth: null },
    { key: "hk", name: "Dilani Perera", role: "Housekeeping Supervisor", basic: 1400, housing: 700, transport: 400, ot: false, join: "2024-02-15", auth: null },
  ];
  EMPS.forEach((e, i) => { void i; });
  const emp = new Map<string, Emp>(EMPS.map((e) => [e.key, e]));
  let ibanSeq = 4180000000;
  for (const [i, e] of EMPS.entries()) {
    const c = await HR.createEmployee(hr, {
      name: e.name, role: e.role, departmentId: undefined, joinDate: at(e.join, 9), contractType: "unlimited", contractStart: at(e.join, 9), basic: e.basic.toFixed(2),
      allowances: [{ name: "Housing", amount: e.housing.toFixed(2) }, { name: "Transport", amount: e.transport.toFixed(2) }], iban: `AE07033${String(ibanSeq + i * 7919).padStart(16, "0")}`,
      licence: e.auth ? { authority: "DHA", number: D.DOCTOR_LICENCES[e.key] ?? `DHA-PRAC-${between(1000000, 4999999)}`, expiry: at(ymdAdd(START, between(30, 700)), 0) } : undefined,
      emiratesIdExpiry: at(ymdAdd(START, between(60, 900)), 0), visaExpiry: at(ymdAdd(START, between(45, 800)), 0), passportExpiry: at(ymdAdd(START, between(200, 2500)), 0),
    });
    e.id = c._id;
  }
  const tryLic = (key: string, number: string, days: number) => ({ key, number, days });
  void tryLic;

  // ---------- compliance ----------
  setNow(at(START, 9));
  await safe("licence", async () => {
    await CMP.addLicence(admin, { kind: "facility", holder: "Elister Medical Center L.L.C", authority: "DHA", number: "DHA-F-0083721", expiry: at("2026-12-14", 0) });
    for (const e of EMPS.filter((x) => x.auth)) await CMP.addLicence(admin, { kind: "practitioner", holder: e.name, authority: "DHA", number: D.DOCTOR_LICENCES[e.key] ?? `DHA-PRAC-${between(1000000, 4999999)}`, expiry: at(ymdAdd(START, between(30, 600)), 0) });
    for (const [title, authority, due] of [
      ["Annual DHA facility inspection and licence renewal", "DHA", "2026-11-30"], ["Dubai Civil Defence fire safety certificate", "Dubai Civil Defence", "2026-12-20"],
      ["Medical waste disposal contract (Dubai Municipality approved vendor)", "Dubai Municipality", "2027-01-15"], ["FANR licence for diagnostic X-ray equipment", "FANR", "2026-12-05"],
      ["Staff BLS/ACLS certification renewal", "DHA", "2027-02-28"], ["Malaffi / NABIDH onboarding readiness review", "DHA", "2027-03-31"], ["Infection control audit and hand-hygiene compliance report", "DHA", "2026-11-25"],
    ] as const) await CMP.addChecklistItem(director, { title, authority, dueDate: at(due, 0), owner: "Clinic Manager" });
    await CMP.publishPolicy(director, { title: "Infection prevention and control policy", body: "Standard precautions, hand hygiene, sterilisation, sharps and medical-waste handling for all clinical areas." });
    await CMP.publishPolicy(director, { title: "Patient privacy and confidentiality policy", body: "Access to patient records is role-based, audited and limited to the care relationship. Disclosures follow DHA and federal health-data law." });
  });

  // ---------- running state ----------
  type PatS = { id: string; sex: "male" | "female"; age: number; kid: boolean; allergies: string[]; plan?: string; policyId?: string; policyEnd?: Date; chronic: boolean; visits: number; email?: boolean; sms: boolean; nat: string; last?: string };
  const pool: PatS[] = [];
  const slotTaken = new Map<string, Set<number>>();
  const unpaid: { id: string; due: string; amount: number; method: "cash" | "card" | "bank" }[] = [];
  const claimsLive: { id: string; payer: string; days: number; submitted: string; amount: number; state: "accepted" | "rejected" | "partial"; since: string }[] = [];
  const stats = { visits: 0, noShow: 0, cancelled: 0, newPatients: 0, insured: 0, selfPay: 0, rx: 0, lab: 0, rad: 0, claims: 0, flaggedCritical: 0 };
  const cashGl = { bal: 0 };
  let petty = 0, bank = 0;
  void bank; void petty;
  const events = new Map<string, (() => Promise<void>)[]>();
  const later = (day: string, fn: () => Promise<void>) => { if (!events.has(day)) events.set(day, []); events.get(day)!.push(fn); };
  const monthVisits = new Map<string, number>();
  let patSeq = 0, nmSeq = 0, docSeq = 0;
  const luhn = (s: string) => { let sum = 0, alt = true; for (let i = s.length - 1; i >= 0; i--) { let d = +s[i]; if (alt) { d *= 2; if (d > 9) d -= 9; } sum += d; alt = !alt; } return (10 - (sum % 10)) % 10; };
  const digits = (n: number) => Array.from({ length: n }, () => between(0, 9)).join("");

  const glBalance = async (code: string) => {
    const a = await db.collection("gl_lines").aggregate([{ $match: { orgId: ORG, accountCode: code } }, { $group: { _id: null, d: { $sum: "$debit" }, c: { $sum: "$credit" } } }]).toArray();
    if (!a[0]) return 0;
    return Number(a[0].d.toString()) - Number(a[0].c.toString());
  };
  const num = (d: unknown) => Number(fromDecimal128(d as never).toString());

  // ---------- patient generation ----------
  async function newPatient(day: string, ctx: Ctx, kid: boolean, female?: boolean, source?: string): Promise<PatS> {
    const o = weighted(D.ORIGINS.map((x) => [x, x.weight] as [D.Origin, number]));
    const sex: "male" | "female" = female ? "female" : chance(0.5) ? "male" : "female";
    const age = kid ? Math.min(14, Math.floor(Math.abs(gauss()) * 5.5)) : Math.max(18, Math.min(82, Math.round(36 + gauss() * 12)));
    const dobD = new RealDate(`${day}T00:00:00Z`); dobD.setUTCFullYear(dobD.getUTCFullYear() - age); dobD.setUTCDate(dobD.getUTCDate() - between(0, 360));
    const dob = dobD.toISOString().slice(0, 10);
    const first = pick(sex === "male" ? o.m : o.f);
    const family = kid && pool.length && chance(0.9) ? pick(o.last) : pick(o.last);
    const fullName = `${first} ${family}`;
    const eid = chance(0.96) ? (() => { const base = `784${dob.slice(0, 4)}${digits(7)}`; const f = base + luhn(base); return `${f.slice(0, 3)}-${f.slice(3, 7)}-${f.slice(7, 14)}-${f.slice(14)}`; })() : undefined;
    const allergies = chance(0.12) ? [pick(D.ALLERGIES)] : [];
    const prefs = { sms: chance(0.92), email: chance(0.6), whatsapp: chance(0.55), marketing: chance(0.34) };
    const p = await createPatient(ctx, {
      fullName, dob, sex, nationality: o.nat, phone: `+9715${pick(["0", "2", "4", "5", "6", "8"])}${digits(7)}`, email: chance(0.62) ? `${first}.${family}${between(1, 99)}@${pick(["gmail.com", "outlook.com", "yahoo.com", "icloud.com"])}`.toLowerCase().replace(/[' ]/g, "") : undefined,
      address: pick(D.AREAS), emiratesId: eid, allergies, referralSource: source ?? weighted(D.REFERRALS), preferredLanguage: o.arabic && chance(0.7) ? "ar" : "en",
      commPrefs: prefs, consents: [{ type: "treatment", granted: true, at: new Date() }, { type: "privacy", granted: true, at: new Date() }, { type: "marketing", granted: prefs.marketing, at: new Date() }],
      emergencyContact: chance(0.5) || kid ? { name: `${pick(sex === "male" ? o.f : o.m)} ${family}`, phone: `+9715${pick(["0", "2", "4", "5", "6", "8"])}${digits(7)}`, relation: kid ? "Parent" : pick(["Spouse", "Sibling", "Friend"]) } : undefined,
    });
    const nat = o.nat;
    const insuredP = nat === "United Arab Emirates" ? 0.88 : kid ? 0.62 : 0.56;
    let plan: string | undefined;
    if (chance(insuredP)) plan = nat === "United Arab Emirates" && chance(0.62) ? "daman-thiqa" : weighted(D.PLANS.filter((x) => x.key !== "daman-thiqa").map((x) => [x.key, x.weight] as [string, number]));
    const s: PatS = { id: p._id, sex, age, kid, allergies: allergies.map((a) => a.substance), plan, chronic: false, visits: 0, sms: prefs.sms, nat };
    pool.push(s); stats.newPatients++;
    return s;
  }

  // ---------- inventory & procurement ----------
  const LOC = (cat: "medicine" | "consumable") => `${ORG}:${cat === "medicine" ? "pharmacy" : "store"}`;
  let poSeq = 0, invSeq = 0;
  const pendingSupplierInvoices: { id: string; due: string; amount: number }[] = [];
  async function replenish(day: string, hour: number, initial = false) {
    const bySupplier = new Map<string, { sku: string; qty: number }[]>();
    for (const it of D.ITEMS) {
      const stock = (await INV.stockOnHand(invMgr, itemId.get(it.sku)!)).usable;
      const target = initial ? it.level * 3 : stock < it.level ? (stock < it.level / 2 ? it.qty * 1.5 : it.qty) : 0;
      if (target > 0) { const l = bySupplier.get(it.supplier) ?? []; l.push({ sku: it.sku, qty: Math.round(target) }); bySupplier.set(it.supplier, l); }
    }
    for (const [sup, lines] of bySupplier) {
      const drift = 1 + 0.012 * ((new RealDate(`${day}T00:00:00Z`).getTime() - new RealDate(`${START}T00:00:00Z`).getTime()) / (365 * 86400000));
      setNow(at(day, hour));
      const po = await PRO.createPurchaseOrder(buyer, { supplierId: supplierId.get(sup)!, lines: lines.map((l) => ({ itemId: itemId.get(l.sku)!, qty: l.qty, unitCost: r2(itemBySku.get(l.sku)!.cost * drift).toFixed(2) })) });
      await PRO.issuePurchaseOrder(buyer, po._id);
      advance(initial ? 300 : 1440);
      const rd = dubaiYmd(new Date());
      const ym = rd.slice(2, 4) + rd.slice(5, 7);
      const grn = await PRO.receiveGoods(buyer, {
        poId: po._id, locationId: LOC(itemBySku.get(lines[0].sku)!.category), idempotencyKey: `grn-${++poSeq}`,
        lines: lines.map((l, i) => ({ itemId: itemId.get(l.sku)!, qty: l.qty, batchNo: `${D.SUPPLIERS[sup].prefix}${ym}-${String(i + 1).padStart(2, "0")}`, expiry: at(ymdAdd(rd, itemBySku.get(l.sku)!.category === "medicine" ? (chance(0.07) ? 200 : between(480, 900)) : 1000), 0) })),
      });
      const net = fromDecimal128(grn.value).toFixed(2);
      const vat = itemBySku.get(lines[0].sku)!.vat ? r2(Number(net) * 0.05).toFixed(2) : "0.00";
      const due = ymdAdd(rd, D.SUPPLIERS[sup].terms);
      const si = await PRO.recordSupplierInvoice(buyer, { supplierId: supplierId.get(sup)!, poId: po._id, invoiceNo: `${D.SUPPLIERS[sup].prefix}-${rd.slice(0, 4)}-${String(++invSeq).padStart(5, "0")}`, invoiceDate: at(rd, 9), dueDate: at(due, 0), net, vat });
      advance(60);
      await PRO.approveSupplierInvoice(fm, si._id);
      pendingSupplierInvoices.push({ id: si._id, due, amount: Number(net) + Number(vat) });
    }
  }

  // ---------- clinical pipeline ----------
  const bump = (m: number) => advance(m);
  async function labFlow(day: string, doc: Staff, encId: string, p: PatS, codes: string[], dxCode: string) {
    const o = await LAB.orderLab(docCtx(doc), { encounterId: encId, testIds: codes.map((c) => testId.get(c)!) });
    stats.lab++;
    bump(4); await LAB.collectSample(lab1, o._id); bump(6); await LAB.receiveSample(lab1, o._id); await LAB.startProcessing(lab1, o._id); bump(8);
    for (const c of codes) {
      const def = labDef.get(c)!;
      let mean = def.mean[p.sex === "male" ? 0 : 1], sd = def.sd;
      if (dxCode === "E11.9" && c === "HBA1C") { mean = 7.5; sd = 1.3; } if (dxCode === "E11.9" && c === "GLU") { mean = 8; sd = 2; }
      if (dxCode === "E55.9" && c === "VITD") { mean = 13; sd = 5; } if (dxCode === "D50.9" && c === "HGB") { mean = 10.2; sd = 1.1; } if (dxCode === "D50.9" && c === "FERR") { mean = 8; sd = 4; }
      if (dxCode === "E78.5" && (c === "CHOL" || c === "TG")) { mean = c === "CHOL" ? 6.3 : 2.6; sd = 0.8; }
      let v = Math.max(0.1, mean + gauss() * sd);
      v = Math.round(v * (def.unit === "U/L" || def.unit === "ng/mL" || def.unit === "µmol/L" ? 1 : 10)) / (def.unit === "U/L" || def.unit === "ng/mL" || def.unit === "µmol/L" ? 1 : 10);
      await LAB.enterResult(lab1, { orderId: o._id, testId: testId.get(c)!, value: v });
    }
    bump(6); await LAB.verifyResults(lab2, o._id);
    const open = (await LAB.listOpenCritical(lab2)).filter((a) => a.orderId === o._id);
    for (const a of open) { stats.flaggedCritical++; await LAB.acknowledgeCritical(docCtx(doc), a._id, "Result reviewed, patient contacted and advised; repeat test and follow-up arranged."); }
    await LAB.releaseOrder(lab2, o._id);
  }
  async function radFlow(doc: Staff, encId: string, code: string) {
    const label: Record<string, [string, string, string, string]> = {
      "RAD-XR-CHEST": ["XR", "Chest X-ray PA", "Lungs clear. Normal cardiac silhouette. No effusion.", "No acute cardiopulmonary abnormality."],
      "RAD-XR-LIMB": ["XR", "Limb X-ray (single view)", "No acute fracture or dislocation. Soft tissues unremarkable.", "No bony injury."],
      "RAD-US-ABD": ["US", "Ultrasound abdomen", "Liver, gallbladder, kidneys and spleen normal in size and echotexture.", "Normal abdominal ultrasound."],
      "RAD-US-OB": ["US", "Obstetric/pelvic ultrasound", "Findings consistent with dates; adnexa normal.", "Unremarkable study."],
    };
    const [modality, study, findings, impression] = label[code];
    const o = await RAD.orderImaging(docCtx(doc), { encounterId: encId, modality: modality as "XR" | "US", study, serviceId: svcId(code) });
    stats.rad++;
    bump(5); await RAD.scheduleImaging(rad1, o._id, new Date(nowMs() + 60_000)); bump(8); await RAD.markPerformed(rad1, o._id, `PACS-${o._id.slice(-8)}`);
    bump(6); await RAD.writeReport(rad1, o._id, { findings, impression }); bump(4); await RAD.releaseReport(rad2, o._id);
  }
  const rxLineFor = (sku: string): { dose: string; frequency: string; durationDays: number; qty: number } => {
    const m: Record<string, [string, string, number, number]> = {
      "METF-500": ["1 tablet", "twice daily with meals", 30, 60], "AMLO-5": ["1 tablet", "once daily", 30, 30], "ATOR-20": ["1 tablet", "once daily at night", 30, 30],
      "AMOX-500": ["1 capsule", "three times daily", 7, 21], "AUG-1G": ["1 tablet", "twice daily after food", 7, 14], "AZI-500": ["1 tablet", "once daily", 3, 3], "CIPR-500": ["1 tablet", "twice daily", 5, 10],
      "PARA-500": ["1-2 tablets", "every 8 hours when required", 3, 15], "IBU-400": ["1 tablet", "three times daily after food", 3, 9], "MEFA-500": ["1 tablet", "three times daily after food", 3, 9],
      "CETI-10": ["1 tablet", "once daily", 7, 7], "LORA-10": ["1 tablet", "once daily", 7, 7], "OMEP-20": ["1 capsule", "once daily before breakfast", 14, 14],
      "VITD-50K": ["1 capsule", "once weekly", 56, 8], "FA-5": ["1 tablet", "once daily", 30, 30], "ORS-SACH": ["1 sachet in 200 ml water", "after each loose stool", 3, 6],
      "MONT-4": ["1 chewable tablet", "once daily at night", 30, 30], "SALB-INH": ["2 puffs", "when required, up to four times daily", 30, 1],
      "AMOX-SYR": ["5 ml", "three times daily", 7, 1], "PARA-SYR": ["5-10 ml", "every 6 hours when required", 3, 1], "IBU-SYR": ["5 ml", "every 8 hours with food", 3, 1], "CETI-SYR": ["5 ml", "once daily", 5, 1],
    };
    const x = m[sku] ?? ["Apply thinly", "twice daily", 14, 1];
    return { dose: x[0], frequency: x[1], durationDays: x[2], qty: x[3] };
  };
  async function rxFlow(doc: Staff, encId: string, p: PatS, skus: string[]) {
    const lines: { itemId: string; dose: string; frequency: string; durationDays: number; qty: number; substitutionAllowed: boolean }[] = [];
    for (const sku of skus) {
      const it = itemBySku.get(sku)!;
      const hay = `${it.name} ${it.generic ?? ""}`.toLowerCase();
      if (p.allergies.some((a) => hay.includes(a.toLowerCase()) || (a === "Penicillin" && /amox|aug/i.test(sku)) || (a === "Ibuprofen" && /ibu|mefa/i.test(sku)) || (a === "Aspirin" && /ibu|mefa/i.test(sku)))) continue;
      const l = rxLineFor(sku);
      if ((await INV.stockOnHand(invMgr, itemId.get(sku)!)).usable < l.qty) continue;
      lines.push({ itemId: itemId.get(sku)!, ...l, substitutionAllowed: false });
    }
    if (!lines.length) return;
    const rx = await RX.createPrescription(docCtx(doc), { encounterId: encId, lines });
    bump(2); await RX.signPrescription(docCtx(doc), rx._id, rx.alerts.some((a) => a.blocking) ? { overrideReason: "Reviewed with patient; tolerated previously." } : {});
    bump(4); await RX.verifyPrescription(pharm, rx._id, { patientConfirmed: true });
    bump(3); await RX.dispense(pharm, { prescriptionId: rx._id, locationId: LOC("medicine"), idempotencyKey: `disp-${rx._id}`, lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty })) });
    stats.rx++;
  }
  const vitalsFor = (p: PatS, dx: D.Dx) => {
    const feverish = ["J02.9", "R50.9", "H66.90", "J03.90", "A08.4", "J06.9", "J20.9"].includes(dx.code) && chance(0.55);
    const temp = feverish ? r2(37.9 + R() * 1.4) : r2(36.4 + R() * 0.6);
    if (p.kid) {
      const w = p.age < 1 ? r2(3.5 + R() * 5) : r2(8 + p.age * 2.2 + gauss() * 1.2), h = p.age < 1 ? Math.round(52 + R() * 20) : Math.round(72 + p.age * 6 + gauss() * 3);
      return { heartRate: between(80, 125), tempC: temp, spo2: between(96, 100), weightKg: Math.max(2.5, w), heightCm: h };
    }
    const htn = dx.code === "I10";
    return { systolic: htn ? between(138, 164) : between(106, 134), diastolic: htn ? between(84, 98) : between(66, 86), heartRate: between(60, 96), respRate: between(13, 19), tempC: temp, spo2: between(96, 99), weightKg: r2((p.sex === "male" ? 77 : 66) + gauss() * 11), heightCm: Math.round((p.sex === "male" ? 172 : 160) + gauss() * 6) };
  };

  const shift = { open: null as null | { ctx: Ctx; id: string; from: Date } };
  async function openDrawer(ctx: Ctx, hh: number, mm: number, day: string) {
    setNow(at(day, hh, mm));
    const s = await safe("openRegister", () => CB.openRegister(ctx, { openingFloat: "500.00" }));
    shift.open = s ? { ctx, id: s._id, from: new Date() } : null;
  }
  async function closeDrawer(hh: number, mm: number, day: string) {
    const o = shift.open; if (!o) return;
    setNow(at(day, hh, mm));
    const taken = await (await import("../src/modules/billing/payment")).cashTakenBy(o.ctx, o.ctx.userId, o.from, new Date());
    const expected = 500 + num(taken.net);
    const varN = chance(0.18) ? pick([-20, -10, -5, 5, 10]) : 0;
    await safe("closeRegister", () => CB.closeRegister(o.ctx, { counted: (expected + varN).toFixed(2), ...(varN ? { note: varN < 0 ? "Short at count; change given in error, reviewed with cashier." : "Over at count; patient change not collected." } : {}) }));
    shift.open = null;
  }
  const cashierAt = (hour: number) => (hour < 15 ? rec1 : rec2);

  async function payInvoice(invoiceId: string, method: "cash" | "card" | "bank" | "link", amount: number, key: string, ctx: Ctx) {
    await recordPayment(ctx, { invoiceId, method, amount: amount.toFixed(2), idempotencyKey: key });
    if (method === "cash") cashGl.bal += amount;
  }

  // ---------- the visit ----------
  const hourW: [number, number][] = [[9, 1], [10, 1.5], [11, 1.5], [12, 1], [13, 0.6], [14, 0.8], [15, 1], [16, 1.3], [17, 1.4], [18, 1.4], [19, 1.2], [20, 0.5]];
  function takeSlot(docId: string, day: string): Date | null {
    const key = `${docId}:${day}`; const set = slotTaken.get(key) ?? new Set<number>(); slotTaken.set(key, set);
    for (let t = 0; t < 30; t++) {
      const h = weighted(hourW); const i = (h - 9) * 3 + between(0, 2);
      if (i < 36 && !set.has(i)) { set.add(i); return at(day, 9 + Math.floor(i / 3), (i % 3) * 20); }
    }
    for (let i = 0; i < 36; i++) if (!set.has(i)) { set.add(i); return at(day, 9 + Math.floor(i / 3), (i % 3) * 20); }
    return null;
  }
  function choosePatient(dept: string, day: string, ctx: Ctx, forced?: PatS): Promise<PatS> {
    if (forced) return Promise.resolve(forced);
    const kidWanted = dept === "PED" || ((dept === "GP" || dept === "DENT" || dept === "DERM") && chance(0.08));
    const femaleOnly = dept === "OBGYN";
    const poolSize = pool.length;
    const pNew = Math.max(0.17, Math.min(0.92, 0.95 * Math.exp(-poolSize / 520)));
    if (poolSize > 0 && !chance(pNew)) {
      for (let t = 0; t < 12; t++) {
        const p = pick(pool);
        if (p.kid !== kidWanted) continue; if (femaleOnly && (p.sex !== "female" || p.age < 17)) continue;
        if (chance(1 - 1 / (1 + p.visits * 0.2))) continue;
        return Promise.resolve(p);
      }
    }
    return newPatient(day, ctx, kidWanted, femaleOnly);
  }
  function pickDx(dept: string, p: PatS): D.Dx {
    for (let t = 0; t < 20; t++) {
      const x = weighted(D.DX[dept].map((d) => [d, d.w] as [D.Dx, number]));
      if (["I10", "E11.9", "E78.5"].includes(x.code) && p.age < 35) continue;
      if (x.code === "Z34.00" && (p.age < 20 || p.age > 44)) continue;
      return x;
    }
    return D.DX[dept][0];
  }

  async function runVisit(day: string, doc: Staff, dept: string, start: Date, mode: "full" | "checkin" | "booked", forced?: PatS) {
    const bookDay = chance(0.45) ? day : ymdAdd(day, -weighted([[1, 40], [2, 25], [3, 15], [5, 12], [7, 8]]));
    const bookAt = bookDay === day ? new Date(start.getTime() - between(40, 240) * 60000) : at(bookDay, between(9, 19), between(0, 59));
    setNow(new Date(Math.min(bookAt.getTime(), start.getTime() - 20 * 60000)));
    const p0 = await choosePatient(dept, bookDay, rec1, forced);
    const p = p0;
    const appt = await bookAppointment(rec1, { patientId: p.id, doctorId: doc._id, start, end: new Date(start.getTime() + 20 * 60000) });
    if (p.sms && chance(0.4)) { setNow(new Date(start.getTime() - 20 * 3600000)); await safe("reminder", () => COM.sendMessage(rec1, { patientId: p.id, templateKey: "appointment_reminder", channel: "sms", vars: { appointmentTime: start.toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" }), doctorName: doc.name, clinicName: "Elister Med" }, dedupeKey: `rem-${appt._id}` })); }
    if (mode === "booked") return;
    const roll = R();
    if (mode === "full" && roll < 0.065) { setNow(new Date(start.getTime() + 25 * 60000)); await markNoShow(rec1, appt._id); stats.noShow++; later(ymdAdd(day, 1), async () => { await safe("followup", () => CRM.createFollowUp(rec1, { patientId: p.id, kind: "missed_appointment", dueAt: new Date(), note: "Missed appointment: call to rebook.", dedupeKey: `miss-${appt._id}` })); }); return; }
    if (mode === "full" && roll < 0.115) { setNow(new Date(start.getTime() - between(90, 1500) * 60000)); await cancelAppointment(rec1, appt._id, pick(["Patient request: schedule conflict", "Patient unwell, will rebook", "Travelling", "Rescheduled by patient"])); stats.cancelled++; return; }

    setNow(new Date(start.getTime() - between(2, 12) * 60000));
    await checkIn(rec1, appt._id);
    if (mode === "checkin") return;
    setNow(new Date(start.getTime() + between(3, 20) * 60000));
    const dx = pickDx(dept, p); p.visits++;
    const ws = await E.openEncounter(docCtx(doc), appt._id);
    const encId = ws.encounter._id;
    bump(3); await E.recordVitals(docCtx(doc), encId, vitalsFor(p, dx));
    bump(1); await E.addDiagnosis(docCtx(doc), encId, { code: dx.code, description: dx.description, primary: true });
    if (chance(0.15) && dept === "GP") await E.addDiagnosis(docCtx(doc), encId, { code: "E66.9", description: "Obesity, unspecified" });
    if (["I10", "E11.9", "E78.5"].includes(dx.code)) { p.chronic = true; await safe("chronicFU", () => CRM.createFollowUp(rec1, { patientId: p.id, kind: "chronic_care", dueAt: new Date(nowMs() + between(28, 90) * 86400000), note: `Review of ${dx.description}.`, dedupeKey: `chronic-${p.id}-${day.slice(0, 7)}` })); }
    bump(6);
    const doExtra = async (spec: string, qtyMax = 1) => { const [code, pr] = spec.split(":"); if (chance(Number(pr))) await addCharge(rec1, { encounterId: encId, serviceId: svcId(code), qty: qtyMax }); };
    for (const x of dx.extra ?? []) await doExtra(x);
    const labs = (dx.labs ?? []).filter((x) => chance(Number(x.split(":")[1]))).map((x) => x.split(":")[0]);
    if (labs.length) await labFlow(day, doc, encId, p, [...new Set(labs)], dx.code);
    if (dx.rad) { const [rc, rp] = dx.rad.split(":"); if (chance(Number(rp))) await radFlow(doc, encId, rc); }
    if (dx.rx?.length) await rxFlow(doc, encId, p, dx.rx);
    const adult = !p.kid;
    await E.saveDraftNote(docCtx(doc), ws.note._id, { s: dx.s, o: `${dx.o}${adult ? "" : ""}`, a: dx.a, p: dx.p });
    bump(2); await E.signNote(docCtx(doc), ws.note._id);
    bump(between(2, 8)); await E.completeEncounter(docCtx(doc), encId);
    stats.visits++;
    const mo = day.slice(0, 7); monthVisits.set(mo, (monthVisits.get(mo) ?? 0) + 1);
    p.last = day;
    // ----- checkout -----
    bump(between(3, 12));
    const hour = Number(new Date(nowMs() + 4 * 3600_000).toISOString().slice(11, 13));
    const cashier = cashierAt(hour);
    const charges = await listUnbilledCharges(cashier, p.id);
    if (!charges.length) return;
    const ids = charges.map((c) => c._id);
    const method = weighted<"cash" | "card" | "bank" | "link">([["card", 58], ["cash", 31], ["bank", 6], ["link", 5]]);
    let invoice: Awaited<ReturnType<typeof finalizeInvoice>> | null = null;
    if (p.plan) {
      const pd = planDef.get(p.plan)!;
      if (!p.policyId || (p.policyEnd && p.policyEnd.getTime() < nowMs())) {
        const startD = p.policyEnd ?? at(ymdAdd(day, -between(5, 330)), 0);
        const endD = new Date(startD.getTime() + 365 * 86400000);
        const pol = await INS.createPolicy(coord, { patientId: p.id, planId: planId.get(p.plan)!, memberNo: `${pd.prefix}${digits(9)}`, startDate: startD, endDate: endD });
        p.policyId = pol._id; p.policyEnd = endD;
      }
      const eligible = chance(0.965);
      await INS.recordEligibility(coord, { patientId: p.id, policyId: p.policyId!, result: eligible ? "eligible" : "not_eligible", source: "manual", reference: `ELG-${String(++nmSeq).padStart(6, "0")}` });
      let ok = eligible;
      const pre = charges.map((c) => c.serviceCode).filter((c) => ["DENT-RCT", "DENT-SURGEXT", "DERM-BIOPSY"].includes(c) && !pd.noDental || c === "DERM-BIOPSY");
      if (ok && pre.length) {
        const est = charges.filter((c) => pre.includes(c.serviceCode)).reduce((a, c) => a + num(c.unitPrice) * c.qty, 0);
        const pa = await INS.requestPreauth(coord, { patientId: p.id, policyId: p.policyId!, serviceCodes: pre, estimatedAmount: est.toFixed(2) });
        if (chance(0.9)) await INS.decidePreauth(fm, pa._id, { approved: true, approvedAmount: est.toFixed(2), reference: `PA-${digits(8)}` }); else { await INS.decidePreauth(fm, pa._id, { approved: false }); ok = false; }
      }
      if (ok) {
        const r = await CL.finalizeInsuredInvoice(coord, { patientId: p.id, chargeIds: ids, policyId: p.policyId! });
        invoice = r.invoice; stats.insured++;
        const v = await CL.validateClaim(coord, r.claim._id);
        if (!v.errors.length) {
          await CL.submitClaim(coord, r.claim._id); stats.claims++;
          const amount = num(r.claim.total);
          if (amount > 0) {
            if (chance(0.075)) { await CL.recordPayerResponse(coord, r.claim._id, { outcome: "rejected", reason: pick(D.DENIAL_REASONS) }); claimsLive.push({ id: r.claim._id, payer: pd.payer, days: pd.days, submitted: day, amount, state: "rejected", since: day }); }
            else { await CL.recordPayerResponse(coord, r.claim._id, { outcome: "accepted" }); claimsLive.push({ id: r.claim._id, payer: pd.payer, days: pd.days, submitted: day, amount, state: "accepted", since: day }); }
          }
        }
      }
    }
    if (!invoice) { invoice = await finalizeInvoice(cashier, { patientId: p.id, chargeIds: ids }); stats.selfPay++; }
    const patientShare = num(invoice.patientShare ?? invoice.total);
    const bal = num(invoice.balance);
    if (bal > 0 && patientShare > 0) {
      const x = R();
      if (x < 0.045) unpaid.push({ id: invoice._id, due: ymdAdd(day, between(2, 28)), amount: bal, method: pick(["card", "cash", "bank"]) });
      else if (x < 0.075 && bal > 100) { const half = Math.floor(bal / 2); await payInvoice(invoice._id, method, half, `pay-${invoice.number}-a`, cashier); unpaid.push({ id: invoice._id, due: ymdAdd(day, between(5, 25)), amount: r2(bal - half), method: "card" }); }
      else await payInvoice(invoice._id, method, bal, `pay-${invoice.number}`, cashier);
    }
    if (chance(0.12)) { bump(30); await safe("feedback", async () => { const rate = weighted([[5, 62], [4, 24], [3, 8], [2, 4], [1, 2]]); await CRM.submitFeedback(rec1, { patientId: p.id, appointmentId: appt._id, rating: rate, nps: rate === 5 ? between(9, 10) : rate === 4 ? between(7, 9) : between(0, 6), comment: chance(0.5) ? pick(D.COMMENTS) : undefined }); }); }
  }

  // ---------- periodic jobs ----------
  async function postMonthly(day: string, key: string, memo: string, lines: { code: string; debit?: string; credit?: string }[]) {
    await safe(`journal:${key.split("-")[0]}`, () => postJournal(acct, { date: new Date(), memo, idempotencyKey: key, sourceRef: { type: "manual", id: key }, lines: lines.map((l) => ({ accountId: `${ORG}:${l.code}`, debit: l.debit, credit: l.credit })) }));
    void day;
  }
  const vatOf = (net: number) => r2(net * 0.05);
  async function bankPay(day: string, key: string, memo: string, expCode: string, net: number, vat = true) {
    const v = vat ? vatOf(net) : 0;
    await postMonthly(day, key, memo, [{ code: expCode, debit: net.toFixed(2) }, ...(v ? [{ code: "1600", debit: v.toFixed(2) }] : []), { code: "1010", credit: (net + v).toFixed(2) }]);
  }

  async function weekly(day: string) {
    // card acquirer settlement
    setNow(at(day, 16));
    const { gatewayUnsettled } = CB;
    const gross = await gatewayUnsettled(fm);
    if (gross.gt(200)) { const g = Number(gross.toFixed(2)); await safe("settle", () => CB.settleCardBatch(fm, { reference: `ACQ-${day}`, gross: g.toFixed(2), fees: r2(g * 0.0225).toFixed(2) })); }
    // insurer remittances
    setNow(at(day, 15));
    const dueByPayer = new Map<string, typeof claimsLive>();
    for (const c of claimsLive) {
      if (c.state === "accepted" && ymdAdd(c.submitted, c.days) <= day && chance(0.93)) { const l = dueByPayer.get(c.payer) ?? []; l.push(c); dueByPayer.set(c.payer, l); }
      if (c.state === "rejected" && ymdAdd(c.since, between(7, 14)) <= day) { /* handled below */ }
    }
    for (const [payer, list] of dueByPayer) {
      const lines = list.slice(0, 120).map((c) => { const deny = chance(0.07); const denied = deny ? r2(c.amount * (0.1 + R() * 0.3)) : 0; return { c, paid: r2(c.amount - denied), denied }; });
      const rem = await safe("remit", () => CL.postRemittance(fm, { payerId: payerId.get(payer)!, reference: `${payer}-RA-${day.replace(/-/g, "")}`, lines: lines.map((l) => ({ claimId: l.c.id, paid: l.paid.toFixed(2), denied: l.denied ? l.denied.toFixed(2) : undefined, reason: l.denied ? pick(D.DENIAL_REASONS) : undefined })) }));
      if (rem) for (const l of lines) { const i = claimsLive.indexOf(l.c); if (l.denied) { l.c.state = "partial"; l.c.since = day; l.c.amount = l.denied; } else if (i >= 0) claimsLive.splice(i, 1); }
    }
    for (const c of [...claimsLive]) {
      if (c.state === "rejected" && ymdAdd(c.since, 9) <= day) {
        await safe("resubmit", async () => { await CL.resubmitClaim(coord, c.id); const v = await CL.validateClaim(coord, c.id); if (v.errors.length) return; await CL.submitClaim(coord, c.id); await CL.recordPayerResponse(coord, c.id, { outcome: "accepted" }); c.state = "accepted"; c.submitted = day; });
      } else if (c.state === "partial" && ymdAdd(c.since, 45) <= day) {
        await safe("writeoff", async () => { await CL.writeOffClaim(fm, c.id, "Denied by payer after review; not recoverable under network agreement"); claimsLive.splice(claimsLive.indexOf(c), 1); });
      }
    }
    // supplier payments due
    setNow(at(day, 11));
    for (const s of [...pendingSupplierInvoices]) if (s.due <= day) { await safe("paySupplier", () => PRO.paySupplier(fm, { invoiceId: s.id, amount: s.amount.toFixed(2), method: "bank", idempotencyKey: `sp-${s.id}` })); pendingSupplierInvoices.splice(pendingSupplierInvoices.indexOf(s), 1); }
    // stock
    await safe("replenish", () => replenish(day, 12));
  }

  async function bankDeposit(day: string) {
    setNow(at(day, 9, 5));
    const cash = await glBalance("1000");
    if (cash > 9000) await safe("deposit", () => CB.transferFunds(fm, { from: "cash", to: "bank", amount: (Math.floor((cash - 6000) / 100) * 100).toFixed(2), idempotencyKey: `dep-${day}`, memo: "Cash deposit to Mashreq current account" }));
  }

  async function attendanceDay(day: string) {
    if (closed.has(day)) return;
    for (const e of EMPS) {
      if (!e.id) continue;
      const doc = staff.find((s) => s.userKey === e.key);
      if (doc && onLeave(doc, day)) continue;
      if (leaveDays.get(e.id)?.has(day)) continue;
      if (e.key === "hk" || chance(0.015)) continue;
      const inn = at(day, 9, between(0, 8) - (chance(0.1) ? 20 : 0) > 0 ? between(0, 8) : 0); inn.setTime(inn.getTime() + between(-6, 8) * 60000);
      const extra = e.ot && chance(0.2) ? between(20, 110) : 0;
      const out = new Date(inn.getTime() + 8 * 3600000 + extra * 60000 + between(0, 6) * 60000);
      await safe("clockIn", () => HR.clockIn(hr, e.id!, inn));
      await safe("clockOut", () => HR.clockOut(hr, e.id!, out));
    }
  }
  const leaveDays = new Map<string, Set<string>>();
  const planLeave = (key: string, typeCode: string, from: string, to: string, reason: string) => {
    const e = emp.get(key)!; const set = leaveDays.get(e.id!) ?? new Set(); leaveDays.set(e.id!, set);
    for (let d = from; d <= to; d = ymdAdd(d, 1)) set.add(d);
    later(ymdAdd(from, -10) < START ? START : ymdAdd(from, -10), async () => { const lr = await safe("leave", () => HR.requestLeave(hr, { employeeId: e.id!, typeCode, from, to, reason })); if (lr) await safe("leaveDecide", () => HR.decideLeave(fm, lr._id, true)); });
  };
  for (const [k, [a, b]] of Object.entries(LEAVES)) planLeave(k, "ANNUAL", a, b, "Annual leave");
  planLeave("rec1", "ANNUAL", "2026-08-17", "2026-08-30", "Annual leave"); planLeave("nur1", "ANNUAL", "2026-07-13", "2026-07-26", "Annual leave"); planLeave("pha", "ANNUAL", "2026-09-07", "2026-09-20", "Annual leave");
  planLeave("lab", "ANNUAL", "2026-06-29", "2026-07-12", "Annual leave"); planLeave("nur2", "ANNUAL", "2026-08-03", "2026-08-16", "Annual leave"); planLeave("mgr", "ANNUAL", "2026-09-21", "2026-09-30", "Annual leave");
  planLeave("rec2", "SICK", "2026-01-12", "2026-01-14", "Influenza"); planLeave("dna", "SICK", "2026-03-04", "2026-03-05", "Gastroenteritis"); planLeave("acc", "UNPAID", "2026-05-18", "2026-05-20", "Personal matters");
  planLeave("rec2", "UNPAID", "2026-04-27", "2026-04-28", "Personal matters");

  async function payrollMonth(day: string) {
    const period = day.slice(0, 7);
    setNow(at(day, 10));
    const run = await safe("payrollPrepare", () => HR.preparePayroll(hr, period, { advanceRecoveryPerMonth: "1000.00" }));
    if (!run) return;
    setNow(at(day, 12)); await safe("payrollApprove", () => HR.approvePayroll(fm, run._id));
    setNow(at(day, 15)); await safe("payrollPay", () => HR.payPayroll(fm, run._id));
  }
  async function consumables(day: string, mo: string) {
    setNow(at(day, 17));
    const n = monthVisits.get(mo) ?? 0;
    for (const [sku, rate] of Object.entries(D.CONSUMABLE_USE)) {
      let need = Math.round(n * rate * (0.9 + R() * 0.2));
      for (const b of await INV.listBatches(invMgr, itemId.get(sku)!)) {
        if (need <= 0) break; const take = Math.min(need, b.qtyOnHand); if (take <= 0) continue;
        await safe("consume", () => INV.adjustStock(invMgr, { batchId: b._id, delta: -take, reason: `Clinical consumption ${mo}` })); need -= take;
      }
    }
  }
  const vatSettle = async (day: string) => {
    setNow(at(day, 11));
    const out = -(await glBalance("2100")), inp = await glBalance("1600");
    const net = r2(out - inp);
    if (out === 0 && inp === 0) return;
    const lines = [{ code: "2100", debit: out.toFixed(2) }, { code: "1600", credit: inp.toFixed(2) }];
    if (net > 0) lines.push({ code: "1010", credit: net.toFixed(2) }); else if (net < 0) lines.push({ code: "1010", debit: (-net).toFixed(2) });
    const filtered = lines.filter((l) => Number(l.debit ?? l.credit) > 0);
    await postMonthly(day, `vat-${day}`, net >= 0 ? "VAT return settlement paid to FTA" : "VAT return: refund received from FTA", filtered);
  };

  // ---------- bank statements (mirrors the ledger, reconciled each month) ----------
  async function bankStatement(day: string) {
    const prev = ymdAdd(day.slice(0, 8) + "01", -1), from = prev.slice(0, 8) + "01";
    const lines = await db.collection("gl_lines").find({ orgId: ORG, accountCode: "1010", date: { $gte: at(from, 0), $lt: at(day.slice(0, 8) + "01", 0) } }).sort({ date: 1 }).toArray();
    if (!lines.length) return;
    const entries = new Map((await db.collection("journal_entries").find({ orgId: ORG, _id: { $in: lines.map((l) => l.entryId) } }).toArray()).map((e) => [String(e._id), e]));
    setNow(at(day, 10));
    await safe("bankImport", () => CB.importBankStatement(fm, { account: "bank", lines: lines.map((l) => { const e = entries.get(String(l.entryId)); return { date: dubaiYmd(l.date), description: String(e?.memo ?? "Bank movement").slice(0, 80), amount: (num(l.debit) - num(l.credit)).toFixed(2), reference: `JE${l.entryNo}` }; }) }));
    await safe("bankMatch", () => CB.autoMatchBank(fm, "bank"));
  }

  // ---------- opening day ----------
  setNow(at(START, 8, 30));
  await postMonthly(START, "opening-capital", "Opening capital: shareholders' contribution and fit-out", [{ code: "1010", debit: "1450000.00" }, { code: "1500", debit: "650000.00" }, { code: "3000", credit: "2100000.00" }]);
  await safe("fundCash", () => CB.transferFunds(fm, { from: "bank", to: "cash", amount: "12000.00", idempotencyKey: "fund-cash", memo: "Opening cash float" }));
  await safe("fundPetty", () => CB.transferFunds(fm, { from: "bank", to: "petty_cash", amount: "3000.00", idempotencyKey: "fund-petty", memo: "Petty cash imprest" }));
  petty = 3000;
  await replenish(START, 9, true);

  // CRM campaigns spread across the year
  const campaigns: [string, string, "recall" | "chronic" | "marketing", "sms" | "whatsapp" | "email", number][] = [
    ["2025-11-18", "Flu season vaccination reminder", "recall", "sms", 300], ["2026-01-12", "Diabetes and hypertension follow-up", "chronic", "whatsapp", 90],
    ["2026-02-10", "Ramadan health screening packages", "marketing", "whatsapp", 365], ["2026-04-06", "Six-monthly dental check recall", "recall", "sms", 180],
    ["2026-06-02", "Summer skin care and sun protection", "marketing", "email", 365], ["2026-09-14", "Back-to-school paediatric check-ups and vaccines", "recall", "sms", 240],
  ];
  for (const [d, name, kind, ch, days] of campaigns) later(d, async () => { setNow(at(d, 11)); const c = await safe("campaign", () => CRM.createCampaign(mgr, { name, kind, channel: ch, lastVisitBeforeDays: days })); if (c) await safe("recall", () => CRM.buildRecallList(mgr, c._id)); });
  // complaints
  for (const [i, d] of ["2025-12-09", "2026-02-24", "2026-04-15", "2026-07-29", "2026-09-22"].entries()) {
    const [cat, desc, res] = D.COMPLAINTS[i];
    later(d, async () => { setNow(at(d, 14)); const c = await safe("complaint", () => CRM.fileComplaint(mgr, { patientId: pool.length ? pick(pool).id : undefined, category: cat, description: desc })); if (!c) return;
      later(ymdAdd(d, 1), async () => { setNow(at(ymdAdd(d, 1), 11)); await safe("complaint2", () => CRM.progressComplaint(mgr, c._id, "investigating", { assignedTo: "Clinic Manager" })); });
      later(ymdAdd(d, 6), async () => { setNow(at(ymdAdd(d, 6), 12)); await safe("complaint3", () => CRM.progressComplaint(mgr, c._id, "resolved", { resolution: res })); }); });
  }
  // incidents
  later("2026-03-10", async () => { setNow(at("2026-03-10", 15)); const i = await safe("incident", () => CMP.reportIncident(director, { title: "Needle-stick injury during sample collection", severity: "medium", description: "Nurse sustained a superficial needle-stick injury; first aid given, source patient screened, post-exposure protocol followed." })); if (i) { await safe("incident2", () => CMP.addCorrectiveAction(director, i._id, { description: "Refresher training on sharps handling and safety cannula use", owner: "Clinic Manager", due: at("2026-04-10", 0) })); } });
  later("2026-06-18", async () => { setNow(at("2026-06-18", 17)); await safe("incident3", () => CMP.reportIncident(director, { title: "Prescription near-miss: look-alike medicine selected", severity: "low", description: "Pharmacist caught a look-alike/sound-alike selection during verification; no dose reached the patient. Shelf separation and tall-man labelling introduced." })); });

  // ---------- the year ----------
  const startMs = Date.now();
  let dayN = 0;
  const monthIdx = (d: string) => (Number(d.slice(0, 4)) - 2025) * 12 + Number(d.slice(5, 7)) - 11;
  const planDays: string[] = []; for (let d = START; d <= END && planDays.length < MAX_DAYS; d = ymdAdd(d, 1)) planDays.push(d);
  for (const day of planDays) {
    dayN++;
    const dom = Number(day.slice(8, 10)), dow = dowOf(day), mo = day.slice(0, 7);
    // scheduled one-offs
    for (const fn of events.get(day) ?? []) await safe("event", fn);
    // monthly money
    if (dom === 1) {
      setNow(at(day, 10));
      await bankPay(day, `rent-${mo}`, `Rent ${mo}: Al Noor Building, Al Qusais`, "5100", 38000);
      await bankPay(day, `cleaning-${mo}`, "Cleaning and pest-control contract", "5800", 2400);
      if (dow !== 0) { await bankDeposit(day); }
    }
    if (dom === 5) {
      setNow(at(day, 11)); const m = Number(day.slice(5, 7));
      const season = [0.55, 0.52, 0.58, 0.7, 0.85, 1.0, 1.25, 1.3, 1.1, 0.85, 0.65, 0.55][m - 1];
      await bankPay(day, `dewa-${mo}`, "DEWA electricity and water", "5200", r2(7400 * season + between(-300, 300)));
      await bankPay(day, `telecom-${mo}`, "Etisalat business internet and telephony", "5800", 890);
      await bankPay(day, `software-${mo}`, "Clinic software, cloud hosting and e-claims subscriptions", "5800", 2850);
    }
    if (dom === 10) { setNow(at(day, 11)); await bankPay(day, `mkt-${mo}`, "Digital marketing: Google Ads, Meta Ads and content", "5700", r2(9800 + monthIdx(day) * 240 + between(-600, 900))); }
    if (dom === 15) { setNow(at(day, 11)); await bankPay(day, `rad-${mo}`, "Teleradiology reporting fees", "5800", 3200 + between(0, 600)); }
    if (dom === 2 && day > "2025-11-30") await bankStatement(day);
    if (dom === 28) {
      const labRev = await (async () => { const a = await db.collection("gl_lines").aggregate([{ $match: { orgId: ORG, accountCode: "4200", date: { $gte: at(`${mo}-01`, 0), $lt: at(ymdAdd(`${mo}-28`, 4).slice(0, 8) + "01", 0) } } }, { $group: { _id: null, c: { $sum: "$credit" }, d: { $sum: "$debit" } } }]).toArray(); return a[0] ? num(a[0].c) - num(a[0].d) : 0; })();
      setNow(at(day, 9)); await payrollMonth(day);
      await consumables(day, mo);
      setNow(at(day, 18));
      await postMonthly(day, `dep-${mo}`, "Monthly depreciation: fit-out and medical equipment (60 months)", [{ code: "5900", debit: "10833.33" }, { code: "1510", credit: "10833.33" }]);
      if (labRev > 0) { setNow(at(day, 18, 30)); await bankPay(day, `reagents-${mo}`, "Laboratory reagents and QC materials", "5500", r2(labRev * 0.24)); }
      if (["01", "04", "07", "10"].includes(day.slice(5, 7))) await vatSettle(day);
      if (day.slice(5, 7) === "12") { setNow(at(day, 12)); await bankPay(day, `dha-lic-${mo}`, "DHA facility and practitioner licence renewals", "5800", 18400, false); }
      if (day.slice(5, 7) === "11") { setNow(at(day, 12)); await bankPay(day, `indem-${mo}`, "Medical malpractice and property insurance premium", "5800", 36000); }
      if (["02", "05", "08", "11"].includes(day.slice(5, 7))) { setNow(at(day, 12)); await bankPay(day, `maint-${mo}`, "Equipment maintenance and calibration (dental unit, X-ray, autoclave)", "5600", 6500); }
    }
    if (dom === 20 && ["2026-01", "2026-03", "2026-05", "2026-07", "2026-09"].includes(mo)) { setNow(at(day, 10)); const e = pick(EMPS.filter((x) => x.ot && x.id)); await safe("advance", () => HR.grantAdvance(fm, { employeeId: e.id!, amount: "3000.00", idempotencyKey: `adv-${mo}` })); }

    if (!closed.has(day)) {
      // morning: collect receivables due today
      await openDrawer(rec1, 8, 55, day);
      setNow(at(day, 9, 30));
      for (const u of [...unpaid]) if (u.due <= day) { await safe("arPay", () => payInvoice(u.id, u.method, u.amount, `ar-${u.id}`, rec1)); unpaid.splice(unpaid.indexOf(u), 1); }
      // volume for the day
      const m = Number(day.slice(5, 7));
      const ramadan = day >= RAMADAN[0] && day <= RAMADAN[1];
      const base = 19 + (monthIdx(day) / 11) * 11;
      let n = Math.round(base * SEASON[m - 1] * (ramadan ? 0.9 : 1) * DOW_FACTOR[dow] * SCALE * (0.88 + R() * 0.24));
      if (dayN === 1) n = Math.round(n * 0.5);
      const firstVisits = (events.get(`first:${day}`) ?? []);
      const plan: { dept: string; doc: Staff; start: Date; forced?: PatS }[] = [];
      for (let i = 0; i < n; i++) {
        const dept = weighted(D.DEPT_WEIGHT); const doc = (docByDept[dept] ?? []).find((s) => !onLeave(s, day)); if (!doc) continue;
        const start = takeSlot(doc._id, day); if (start) plan.push({ dept, doc, start });
      }
      void firstVisits;
      plan.sort((a, b) => a.start.getTime() - b.start.getTime());
      let cur: "am" | "pm" = "am";
      for (const v of plan) {
        const h = Number(new Date(v.start.getTime() + 4 * 3600_000).toISOString().slice(11, 13));
        if (cur === "am" && h >= 15) { await closeDrawer(15, 2, day); await openDrawer(rec2, 15, 4, day); cur = "pm"; }
        await safe("visit", () => runVisit(day, v.doc, v.dept, v.start, "full"));
      }
      if (cur === "am") { await closeDrawer(15, 2, day); await openDrawer(rec2, 15, 4, day); }
      await closeDrawer(21, 10, day);
      // CRM enquiries
      for (let i = 0, k = between(0, 2); i < k; i++) {
        setNow(at(day, between(10, 19), between(0, 59)));
        const [ch, src] = pick(D.ENQUIRY_CHANNELS);
        const o = pick(D.ORIGINS); const sex = chance(0.5);
        const e = await safe("enquiry", () => CRM.createEnquiry(rec1, { name: `${pick(sex ? o.m : o.f)} ${pick(o.last)}`, phone: `+9715${pick(["0", "2", "4", "5", "6", "8"])}${digits(7)}`, channel: ch, source: src, interest: pick(D.ENQUIRY_INTERESTS) }));
        if (!e) continue;
        const x = R();
        if (x < 0.5) later(day, async () => undefined);
        if (x < 0.55) later(ymdAdd(day, 1), async () => { setNow(at(ymdAdd(day, 1), 11)); await safe("enq2", () => CRM.updateEnquiry(rec1, e._id, { status: "lost", note: "Prefers a clinic closer to home." })); });
        else if (x < 0.85) { later(ymdAdd(day, 1), async () => { setNow(at(ymdAdd(day, 1), 10)); await safe("enq3", () => CRM.updateEnquiry(rec1, e._id, { status: "contacted", note: "Called back, shared pricing and available slots." })); });
          if (chance(0.7)) later(ymdAdd(day, between(2, 4)), async () => { const d2 = ymdAdd(day, between(0, 0)); void d2; setNow(at(ymdAdd(day, 2), 12)); const o2 = pick(D.ORIGINS); const f = chance(0.5);
            const r = await safe("enqConvert", () => CRM.convertEnquiry(rec1, e._id, { fullName: e.name, dob: `${between(1965, 2002)}-${pad(between(1, 12))}-${pad(between(1, 28))}`, sex: f ? "female" : "male", nationality: o2.nat, phone: e.phone, preferredLanguage: "en", consents: [{ type: "treatment", granted: true, at: new Date() }], referralSource: e.source }));
            if (r) { stats.newPatients++; pool.push({ id: r.patientId, sex: f ? "female" : "male", age: 30, kid: false, allergies: [], chronic: false, visits: 0, sms: true, nat: o2.nat }); } }); }
      }
      // weekly jobs (Thursday)
      if (dow === 4) { await weekly(day); }
      if (dow === 1 && dom !== 1) await bankDeposit(day);
      // petty cash
      if (dow === 2 || dow === 5) {
        setNow(at(day, 13));
        const amt = r2(40 + R() * 380);
        if (petty < amt + 400) { await safe("pettyTop", () => CB.transferFunds(fm, { from: "bank", to: "petty_cash", amount: "3000.00", idempotencyKey: `pettytop-${day}`, memo: "Petty cash replenishment" })); petty += 3000; }
        const ok = await safe("petty", () => CB.pettyCashExpense(acct, { expenseCode: "5800", amount: amt.toFixed(2), description: pick(["Drinking water and refreshments", "Courier and document delivery", "Printer paper and stationery", "Taxi fare for document submission", "Pantry supplies", "Cleaning supplies", "Parking and Salik top-up", "Patient waiting-area flowers"]), idempotencyKey: `petty-${day}` }));
        if (ok) petty -= amt;
      }
      setNow(at(day, 21, 30));
      await attendanceDay(day);
    }
    if (dayN % 20 === 0) console.log(`  ${day}  visits ${stats.visits}  patients ${pool.length}  claims ${stats.claims}  (${Math.round((Date.now() - startMs) / 1000)}s)`);
  }
  uninstallClock();
  void cashGl;

  // ---------- today: live queue, upcoming bookings ----------
  if (MAX_DAYS === Infinity) {
    installClock();
    const now = new RealDate();
    const nowDub = new RealDate(now.getTime() + 4 * 3600_000);
    const hh = nowDub.getUTCHours() + nowDub.getUTCMinutes() / 60;
    const todayOpen = dowOf(TODAY) !== 0 && !HOLIDAYS[TODAY];
    if (todayOpen) {
      const n = Math.round(24 * SCALE);
      const planT: { dept: string; doc: Staff; start: Date }[] = [];
      for (let i = 0; i < n; i++) { const dept = weighted(D.DEPT_WEIGHT); const doc = (docByDept[dept] ?? [])[0]; if (!doc) continue; const s = takeSlot(doc._id, TODAY); if (s) planT.push({ dept, doc, start: s }); }
      planT.sort((a, b) => a.start.getTime() - b.start.getTime());
      setNow(now);
      for (const v of planT) {
        const sh = (v.start.getTime() - now.getTime()) / 3600000;
        const mode = sh < -0.75 ? "full" : sh < 0.25 ? "checkin" : "booked";
        if (mode === "full" && hh < 9.75) continue;
        const real = mode === "full" ? await safe("visitToday", () => runVisit(TODAY, v.doc, v.dept, v.start, "full")) : await safe("visitToday", () => runVisit(TODAY, v.doc, v.dept, v.start, mode));
        void real; setNow(now);
      }
    }
    for (let k = 1; k <= 10; k++) {
      const d = ymdAdd(TODAY, k); if (dowOf(d) === 0 || HOLIDAYS[d]) continue;
      for (let i = 0; i < Math.round(14 * SCALE); i++) { const dept = weighted(D.DEPT_WEIGHT); const doc = (docByDept[dept] ?? [])[0]; if (!doc) continue; const s = takeSlot(doc._id, d); if (s) { setNow(now); await safe("future", () => runVisit(d, doc, dept, s, "booked")); } }
    }
    uninstallClock();
  }

  // ---------- export ----------
  await closeClient();
  const { MongoClient } = await import("mongodb");
  const c = new MongoClient(rs.getUri()); await c.connect();
  const sdb = c.db("healthos_year");
  const outDir = path.resolve(".seed-cache/year");
  fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
  const names = (await sdb.listCollections().toArray()).map((x) => x.name).filter((n) => !n.startsWith("system.") && n !== "session" && n !== "verification");
  let docsTotal = 0;
  for (const n of names) {
    const out = fs.createWriteStream(path.join(outDir, `${n}.ejson`));
    let cnt = 0;
    for await (const d of sdb.collection(n).find({})) { out.write(BSON.EJSON.stringify(d, { relaxed: false }) + "\n"); cnt++; }
    await new Promise((res) => out.end(res));
    docsTotal += cnt;
  }
  const st = await sdb.stats();
  console.log("\nBuild summary", JSON.stringify(stats));
  console.log(`Collections: ${names.length}, documents: ${docsTotal}, data ${(st.dataSize / 1e6).toFixed(0)} MB, storage ${(st.storageSize / 1e6).toFixed(0)} MB, indexes ${(st.indexSize / 1e6).toFixed(0)} MB`);
  console.log("Non-fatal step errors:", JSON.stringify(errors, null, 1));
  fs.writeFileSync(path.join(outDir, "_meta.json"), JSON.stringify({ builtAt: new RealDate().toISOString(), end: END, org: ORG, db: "healthos_year", collections: names, stats, docsTotal }));
  console.log(`Exported to ${outDir} in ${Math.round((Date.now() - t0) / 1000)}s`);

  // verify against the books while the in-memory db is still up
  process.env.MONGODB_URI = rs.getUri(); process.env.MONGODB_DB = "healthos_year";
  const { verifyBooks } = await import("./year/verify");
  const bad = await verifyBooks(ORG);
  await c.close(); await rs.stop();
  process.exit(bad ? 2 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
