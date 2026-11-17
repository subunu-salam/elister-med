/**
 * Rolling demo activity: keeps the demo clinic "alive" so dashboards and the personal assistant's daily report always have recent days to
 * talk about. Fills every missing working day from up to 35 days ago through today, plus bookings for tomorrow, and on later runs only
 * tops up the days since the last run (a marker per day makes it idempotent).
 *
 * Like seed-activity and seed-year it drives the REAL services (booking, check-in, consultation, invoice, payment) under a simulated clock
 * (scripts/year/clock.ts), so invoices, payments and ledger entries are genuine, correctly dated and balanced. All people are fictional.
 * Runs in demo mode only (ELISTER_DEMO=1, from scripts/vercel-build.sh). Never fails the build: errors are logged and skipped.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { closeClient, getDb, tenantCol } from "../src/core/db";
import { permissionsFor, type RoleKey } from "../src/core/rbac/roles";
import type { Ctx } from "../src/core/rbac/authorize";
import { createPatient } from "../src/modules/patients/service";
import { bookAppointment, cancelAppointment, markNoShow } from "../src/modules/appointments/service";
import { checkIn } from "../src/modules/queue/service";
import { openEncounter, recordVitals, addDiagnosis, saveDraftNote, signNote, completeEncounter } from "../src/modules/emr/service";
import { listUnbilledCharges } from "../src/modules/billing/charges";
import { finalizeInvoice } from "../src/modules/billing/invoice";
import { recordPayment } from "../src/modules/billing/payment";
import { installClock, setNow, uninstallClock, RealDate } from "./year/clock";

const ORG = "demo-dubai-clinic", BRANCH = `${ORG}:main`;
const BACKFILL_DAYS = Number(process.env.SEED_ROLLING_DAYS ?? 35);
const mk = (roles: RoleKey[], userId: string): Ctx => ({ userId, orgId: ORG, branchId: BRANCH, roles, permissions: permissionsFor(roles) });

const FIRST = ["Fatima", "Ahmed", "Maryam", "Omar", "Sara", "Rashid", "Aisha", "Yousef", "Layla", "Hamdan", "Noor", "Khalid", "Priya", "Zayed", "Hana", "Salem", "Reem", "Faisal", "Divya", "Tariq", "Mona", "Arjun", "Lina", "Saif", "Anjali", "Bilal", "Huda", "Rahul", "Dana", "Majid"];
const LAST = ["Al Mazrouei", "Al Suwaidi", "Khan", "Siddiqui", "Thomas", "Al Falasi", "Rahman", "Nair", "Haddad", "Al Ketbi", "Fernandes", "Ibrahim", "Menon", "Al Nuaimi", "Kobeissi", "Al Ali", "Pillai", "Saleh", "Varghese", "Hussain"];
const DX: Record<string, [string, string][]> = {
  GP: [["J06.9", "Acute upper respiratory infection"], ["R51", "Headache"], ["I10", "Essential hypertension"], ["E11.9", "Type 2 diabetes mellitus without complications"], ["M54.5", "Low back pain"]],
  DENT: [["K02.9", "Dental caries, unspecified"], ["K05.1", "Chronic gingivitis"], ["K08.8", "Other disorders of teeth"]],
  DERM: [["L70.0", "Acne vulgaris"], ["L20.9", "Atopic dermatitis, unspecified"], ["L30.9", "Dermatitis, unspecified"]],
};
const SOAP = { s: "Presented with the reported complaint for several days.", o: "Examination unremarkable apart from the finding noted.", a: "Assessment recorded by the clinician.", p: "Treatment advised and follow-up arranged." };

function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const dubaiYmd = (ms: number) => new RealDate(ms + 4 * 3600_000).toISOString().slice(0, 10);
const addDays = (ymd: string, n: number) => new RealDate(new RealDate(`${ymd}T12:00:00Z`).getTime() + n * 86400_000).toISOString().slice(0, 10);
const dow = (ymd: string) => new RealDate(`${ymd}T12:00:00Z`).getUTCDay();
const slotAt = (ymd: string, i: number) => new RealDate(`${ymd}T${String(9 + Math.floor((i * 20) / 60)).padStart(2, "0")}:${String((i * 20) % 60).padStart(2, "0")}:00+04:00`);
const safe = async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => { try { return await fn(); } catch (e) { errors[label] = (errors[label] ?? 0) + 1; if (errors[label] === 1) console.warn(`  ! ${label}: ${(e as Error).message}`); return undefined; } };
const errors: Record<string, number> = {};

type Doc = { _id: string; userId?: string; departmentId: string };

async function main() {
  if (process.env.ELISTER_DEMO !== "1" && process.env.SEED_ROLLING_FORCE !== "1") { console.log("seed-rolling: demo mode only, skipped."); return; }
  const db = await getDb();
  if (!(await db.collection("orgs").findOne({ _id: ORG as never }))) { console.log("seed-rolling: demo org not found, skipped."); return; }
  const reg = mk(["receptionist"], "seed-reception");
  const docs = (await tenantCol<Doc>(ORG, "staff").find({ role: "doctor", active: true } as never)).filter((d) => d.userId);
  if (!docs.length) { console.log("seed-rolling: no doctors, skipped."); return; }
  const markers = db.collection<{ orgId: string; key: string; at: Date }>("seed_markers");

  const realNow = RealDate.now(), today = dubaiYmd(realNow), tomorrow = addDays(today, 1);
  const days: string[] = [];
  for (let d = addDays(today, -BACKFILL_DAYS); d <= tomorrow; d = addDays(d, 1)) if (dow(d) !== 0) days.push(d); // clinic closed Sundays
  const done = new Set((await markers.find({ orgId: ORG, key: { $regex: "^rolling:" } }).toArray()).map((m) => m.key.slice(8)));
  // Newest first: tomorrow, today, yesterday… are what the dashboard and the assistant's report talk about.
  const todo = days.filter((d) => !done.has(d) || d === today || d === tomorrow).reverse();
  const deadline = RealDate.now() + Number(process.env.SEED_ROLLING_BUDGET_MIN ?? 15) * 60_000; // never let a build time out
  if (!todo.length) { console.log("seed-rolling: up to date."); return; }
  console.log(`▶ seed-rolling: ${todo.length} day(s), newest first (${todo[0]} back to ${todo[todo.length - 1]})`);

  // a pool of returning patients, grown a little every day
  const pool: string[] = (await tenantCol<{ _id: string }>(ORG, "patients").find({} as never, { projection: { _id: 1 }, limit: 400 })).map((p) => p._id);
  installClock();
  let visits = 0, paid = 0;
  try {
    for (const day of todo) {
      if (RealDate.now() > deadline) { console.log(`  seed-rolling: time budget used, stopping before ${day} (next deploy continues).`); break; }
      const R = rng(Number(day.replace(/-/g, "")));
      const isToday = day === today, isTomorrow = day === tomorrow;
      // Already-seeded today/tomorrow: only add what is missing (re-runs during the day must not double the book).
      const existing = await tenantCol(ORG, "appointments").count({ start: { $gte: slotAt(day, 0), $lt: new RealDate(`${day}T23:59:00+04:00`) }, createdBy: "seed-reception" } as never).catch(() => 0);
      if ((isToday || isTomorrow) && existing > 0) continue;
      const busy = dow(day) === 6 ? 0.7 : 1; // Saturdays a bit quieter
      const n = Math.round((16 + Math.floor(R() * 10)) * busy * (isTomorrow ? 0.75 : 1));

      // new patients registered that morning
      setNow(new RealDate(`${day}T08:30:00+04:00`));
      const fresh = isTomorrow ? 0 : 2 + Math.floor(R() * 4);
      for (let k = 0; k < fresh; k++) {
        const name = `${FIRST[Math.floor(R() * FIRST.length)]} ${LAST[Math.floor(R() * LAST.length)]}`;
        const p = await safe("createPatient", () => createPatient(reg, {
          fullName: name, dob: `${1955 + Math.floor(R() * 50)}-0${1 + Math.floor(R() * 9)}-1${Math.floor(R() * 9)}`, sex: R() < 0.5 ? "female" : "male",
          phone: `+97155${String(3000000 + Math.floor(R() * 6999999))}`, nationality: ["UAE", "India", "Pakistan", "Philippines", "Egypt", "Lebanon"][Math.floor(R() * 6)],
          referralSource: ["instagram", "walk-in", "referral", "google"][Math.floor(R() * 4)], preferredLanguage: R() < 0.3 ? "ar" : "en",
          consents: [{ type: "treatment", granted: true, at: new Date() }],
        }));
        if (p) pool.push(p._id);
      }
      if (!pool.length) continue;

      const slots: Record<string, number> = {};
      for (let v = 0; v < n; v++) {
        const doc = docs[Math.floor(R() * docs.length)];
        const i = (slots[doc._id] = (slots[doc._id] ?? 0) + 1) - 1;
        if (i > 26) continue;
        const start = slotAt(day, i);
        const patientId = pool[Math.floor(R() * pool.length)];
        // booked a day or two ahead (tomorrow's bookings are made today)
        setNow(new RealDate(Math.min(start.getTime() - (1 + Math.floor(R() * 2)) * 86400_000, realNow - 60_000)));
        const appt = await safe("book", () => bookAppointment(reg, { patientId, doctorId: doc._id, start, end: new RealDate(start.getTime() + 20 * 60_000) }));
        if (!appt) continue;
        if (isTomorrow || start.getTime() > realNow - 30 * 60_000) continue; // future (or about to start): stays booked

        const roll = R();
        setNow(new RealDate(start.getTime() + 5 * 60_000));
        if (roll < 0.04) { await safe("cancel", () => cancelAppointment(reg, appt._id, "Patient rescheduled")); continue; }
        if (roll < 0.11) { setNow(new RealDate(start.getTime() + 40 * 60_000)); await safe("noShow", () => markNoShow(reg, appt._id)); continue; }

        const docCtx = mk(["doctor"], doc.userId!);
        setNow(new RealDate(start.getTime() - 10 * 60_000));
        if (!(await safe("checkIn", () => checkIn(reg, appt._id)))) continue;
        setNow(new RealDate(start.getTime() + 2 * 60_000));
        const w = await safe("openEncounter", () => openEncounter(docCtx, appt._id));
        if (!w) continue;
        const code = doc.departmentId.split(":").pop()!;
        const dx = (DX[code] ?? DX.GP)[Math.floor(R() * (DX[code] ?? DX.GP).length)];
        await safe("vitals", () => recordVitals(docCtx, w.encounter._id, { systolic: 108 + Math.floor(R() * 30), diastolic: 68 + Math.floor(R() * 18), heartRate: 64 + Math.floor(R() * 24), tempC: 36.5 + Math.round(R() * 6) / 10 }));
        await safe("diagnosis", () => addDiagnosis(docCtx, w.encounter._id, { code: dx[0], description: dx[1], primary: true }));
        await safe("note", async () => { await saveDraftNote(docCtx, w.note._id, SOAP); await signNote(docCtx, w.note._id); });
        setNow(new RealDate(start.getTime() + 18 * 60_000));
        if (!(await safe("complete", () => completeEncounter(docCtx, w.encounter._id)))) continue;
        visits++;

        setNow(new RealDate(start.getTime() + 22 * 60_000));
        const charges = (await safe("charges", () => listUnbilledCharges(reg, patientId))) ?? [];
        if (!charges.length) continue;
        const inv = await safe("invoice", () => finalizeInvoice(reg, { patientId, chargeIds: charges.map((c) => c._id) }));
        if (!inv || R() < 0.12) continue; // ~12% left unpaid: receivables of different ages
        const total = Number(inv.total.toString());
        const part = R() < 0.06;
        const ok = await safe("payment", () => recordPayment(reg, { invoiceId: inv._id, method: (["cash", "card", "card", "card", "bank"] as const)[Math.floor(R() * 5)], amount: (part ? total / 2 : total).toFixed(2), idempotencyKey: `roll-${appt._id}` }));
        if (ok) paid++;
      }
      console.log(`  ${day}: done (${visits} visits so far)`);
      if (!isToday && !isTomorrow) await markers.updateOne({ orgId: ORG, key: `rolling:${day}` }, { $set: { at: new RealDate() } }, { upsert: true });
    }
  } finally { uninstallClock(); }
  console.log(`  seed-rolling: ${visits} completed visits, ${paid} paid.${Object.keys(errors).length ? ` Skipped: ${JSON.stringify(errors)}` : ""}`);
}

main().then(async () => { await closeClient(); process.exit(0); }).catch(async (e) => { console.error("seed-rolling failed (build continues):", e); await closeClient().catch(() => null); process.exit(0); });
