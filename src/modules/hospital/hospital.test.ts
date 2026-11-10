import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol, withTransaction } from "@/core/db";
import { money, toDecimal128 } from "@/core/money";
import { ctxFor } from "@/test/helpers";
import { ensureChartOfAccounts } from "@/modules/ledger/accounts";
import { trialBalance } from "@/modules/reports/trialBalance";
import { createPatient } from "@/modules/patients/service";
import { createItem, receiveIntoStock } from "@/modules/inventory/service";
import { listUnbilledCharges } from "@/modules/billing/charges";
import {
  setHospitalConfig, createWard, createBed, bedBoard, markBedClean, admitPatient, transferBed, recordObservation, orderInpatientMedication, administerDose, listMar, dischargePatient,
  registerEr, triage, erQueue, erEscalations, assignErTeam, disposeEr, linkErPatient, createTheatre, scheduleSurgery, completeChecklistItem, startSurgery, recordSurgeryConsent,
  useTheatreMaterial, moveToRecovery, recordRecoveryObservation, completeSurgery, cancelSurgery, hospitalDashboard,
} from "./service";

const ORG = "org-hosp";
const admin = ctxFor(["org_admin"], ORG, "adm1", "br1");
const doctor = ctxFor(["doctor"], ORG, "doc1", "br1");
const nurse = ctxFor(["nurse"], ORG, "nur1", "br1");
const reg = ctxFor(["receptionist"], ORG, "recep", "br1");
const im = ctxFor(["inventory_manager"], ORG, "im1", "br1");
const fin = ctxFor(["finance_manager"], ORG, "fin1", "br1");
let wardId = "", bed1 = "", bed2 = "", p1 = "", p2 = "", p3 = "";

beforeAll(async () => {
  await ensureIndexes();
  await ensureChartOfAccounts(ORG);
  const y = new Date().getUTCFullYear();
  for (const year of [y - 1, y, y + 1]) for (let m = 1; m <= 12; m++)
    await tenantCol<any>(ORG, "fiscal_periods").insertOne({ _id: `${ORG}:${year}-${m}`, year, month: m, status: "open", start: new Date(Date.UTC(year, m - 1, 1, -4)), end: new Date(Date.UTC(year, m, 1, -4)) });
  await tenantCol<any>(ORG, "tax_codes").insertOne({ _id: `${ORG}:t`, code: "STD", rate: toDecimal128(money("5")), kind: "standard", reviewRequired: true });
  await tenantCol<any>(ORG, "services").insertOne({ _id: "svc-bed", code: "BED-DAY", name: "Ward bed per day", kind: "inpatient", price: toDecimal128(money("500.00")), taxCode: "STD", revenueAccountSystem: "rev_procedure", departmentId: "WARD", active: true });
  await tenantCol<any>(ORG, "services").insertOne({ _id: "svc-ot", code: "OT-FEE", name: "Theatre fee", kind: "procedure", price: toDecimal128(money("2500.00")), taxCode: "STD", revenueAccountSystem: "rev_procedure", departmentId: "OT", active: true });
  const mk = async (n: string, extra = {}) => (await createPatient(reg, { fullName: n, dob: "1980-01-01", sex: "male", phone: `+9715${Math.floor(10000000 + Math.random() * 8999999)}`, ...extra }))._id;
  p1 = await mk("Inpatient One"); p2 = await mk("Inpatient Two", { allergies: [{ substance: "Penicillin", severity: "severe" }] }); p3 = await mk("Surgical Three");
});
afterAll(async () => { await closeClient(); });

describe("module gating", () => {
  it("everything is refused while the hospital module is off (the default)", async () => {
    await tenantCol<any>(ORG, "orgs").insertOne({ _id: ORG, name: "Hosp", modules: { hospital: false } });
    await expect(createWard(admin, { code: "W1", name: "Ward 1" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(registerEr(doctor, { alias: "Unknown", complaint: "x", arrivalMode: "walk-in" })).rejects.toMatchObject({ code: "CONFLICT" });
    await tenantCol<any>(ORG, "orgs").updateOne({ _id: ORG }, { $set: { "modules.hospital": true } });
    await setHospitalConfig(admin, { bedServiceId: "svc-bed", theatreServiceId: "svc-ot", erThresholdsMinutes: { "2": 10, "3": 30 } });
  });
  it("roles still apply when the module is on", async () => {
    await expect(createWard(reg, { code: "W9", name: "Nope" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("inpatient", () => {
  it("claims a bed atomically: parallel admissions to one bed produce exactly one admission", async () => {
    wardId = (await createWard(admin, { code: "W1", name: "Medical Ward" }))._id;
    bed1 = (await createBed(admin, { wardId, bedNo: "01" }))._id;
    bed2 = (await createBed(admin, { wardId, bedNo: "02" }))._id;
    await expect(createBed(admin, { wardId, bedNo: "01" })).rejects.toMatchObject({ code: "CONFLICT" });
    const rs = await Promise.allSettled([admitPatient(doctor, { patientId: p1, bedId: bed1, doctorId: "d", reason: "Pneumonia" }), admitPatient(doctor, { patientId: p2, bedId: bed1, doctorId: "d", reason: "Cellulitis" })]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const board = await bedBoard(nurse);
    expect(board[0].beds.find((b) => b._id === bed1)!.status).toBe("occupied");
    expect(board[0].occupancy).toBe(0.5);
  });

  it("one active admission per patient; transfer frees the old bed into cleaning, then free", async () => {
    const adm = (await tenantCol<any>(ORG, "admissions").findOne({ status: "admitted" }));
    await expect(admitPatient(doctor, { patientId: adm.patientId, bedId: bed2, doctorId: "d", reason: "again" })).rejects.toMatchObject({ code: "CONFLICT" });
    await transferBed(doctor, adm._id, bed2);
    expect((await tenantCol<any>(ORG, "beds").findOne({ _id: bed1 })).status).toBe("cleaning");
    await expect(transferBed(doctor, adm._id, bed2)).rejects.toMatchObject({ code: "CONFLICT" });
    await markBedClean(nurse, bed1);
    expect((await tenantCol<any>(ORG, "beds").findOne({ _id: bed1 })).status).toBe("free");
  });

  it("observations validate; MAR blocks allergy matches without override, needs reasons for held doses, never double-records", async () => {
    const adm = (await tenantCol<any>(ORG, "admissions").findOne({ status: "admitted" }));
    await recordObservation(nurse, { admissionId: adm._id, systolic: 120, diastolic: 80, spo2: 97 });
    await expect(recordObservation(nurse, { admissionId: adm._id, spo2: 400 })).rejects.toMatchObject({ code: "VALIDATION" });
    const amox = (await createItem(im, { sku: "AMOX-IV", name: "Amoxicillin IV", genericName: "amoxicillin penicillin-class", category: "medicine", sellingPrice: "30.00" }))._id;
    const para = (await createItem(im, { sku: "PARA-IV", name: "Paracetamol IV", category: "medicine", sellingPrice: "10.00" }))._id;
    // make the admitted patient allergic through p2 only if they are p2
    if (adm.patientId === p2) await expect(orderInpatientMedication(doctor, { admissionId: adm._id, itemId: amox, dose: "1 g", route: "IV", everyHours: 8 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(orderInpatientMedication(nurse, { admissionId: adm._id, itemId: para, dose: "1 g", route: "IV", everyHours: 6 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const doses = await orderInpatientMedication(doctor, { admissionId: adm._id, itemId: para, dose: "1 g", route: "IV", everyHours: 6 });
    expect(doses).toHaveLength(4);
    await expect(administerDose(nurse, doses[0]._id, { status: "held" })).rejects.toMatchObject({ code: "VALIDATION" });
    await administerDose(nurse, doses[0]._id, { status: "given" });
    await expect(administerDose(nurse, doses[0]._id, { status: "given" })).rejects.toMatchObject({ code: "CONFLICT" });
    await administerDose(nurse, doses[1]._id, { status: "held", reason: "Patient nil by mouth for procedure" });
    expect((await listMar(nurse, adm._id)).map((d) => d.status)).toEqual(["given", "held", "scheduled", "scheduled"]);
  });

  it("allergy override is documented when the prescriber accepts the risk", async () => {
    const adm = await admitPatient(doctor, { patientId: p2, bedId: bed1, doctorId: "d", reason: "Cellulitis" }).catch(async () => tenantCol<any>(ORG, "admissions").findOne({ patientId: p2, status: "admitted" }));
    const pen = (await createItem(im, { sku: "PEN-V", name: "Penicillin V", genericName: "penicillin", category: "medicine", sellingPrice: "12.00" }))._id;
    await expect(orderInpatientMedication(doctor, { admissionId: adm._id, itemId: pen, dose: "500 mg", route: "PO", everyHours: 6 })).rejects.toMatchObject({ code: "CONFLICT" });
    const ok = await orderInpatientMedication(doctor, { admissionId: adm._id, itemId: pen, dose: "500 mg", route: "PO", everyHours: 6, allergyOverride: "Tolerated before per specialist; monitored" });
    expect(ok.length).toBe(4);
  });

  it("discharge needs a summary; bed-day charges are created once per day of stay", async () => {
    const adm = await tenantCol<any>(ORG, "admissions").findOne({ patientId: p2, status: "admitted" });
    await expect(dischargePatient(doctor, adm._id, { summary: " ", disposition: "home" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(dischargePatient(nurse, adm._id, { summary: "ok", disposition: "home" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const r = await dischargePatient(doctor, adm._id, { summary: "Recovered; oral antibiotics; review in 1 week", disposition: "home", at: new Date(adm.admittedAt.getTime() + 2.5 * 86400000) });
    expect(r.days).toBe(3);
    expect((await listUnbilledCharges(reg, p2)).filter((c) => c.serviceCode === "BED-DAY")).toHaveLength(3);
    await expect(dischargePatient(doctor, adm._id, { summary: "again", disposition: "home" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("emergency department", () => {
  it("queue is ordered by acuity then wait; untriaged first; escalation uses configured thresholds only", async () => {
    const a = await registerEr(nurse, { alias: "Unknown male 1", complaint: "Collapsed in street", arrivalMode: "ambulance" });
    const b = await registerEr(nurse, { patientId: p3, complaint: "Sprained ankle", arrivalMode: "walk-in" });
    const c = await registerEr(nurse, { patientId: p1, complaint: "Chest pain", arrivalMode: "walk-in" });
    await expect(registerEr(nurse, { complaint: "x", arrivalMode: "walk-in" })).rejects.toMatchObject({ code: "VALIDATION" });
    await triage(nurse, b._id, { level: 4, note: "stable" });
    await triage(nurse, c._id, { level: 2, vitals: { heartRate: 110 } });
    await expect(triage(nurse, c._id, { level: 9 as never })).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await erQueue(nurse)).map((e) => e._id)).toEqual([a._id, c._id, b._id]);
    const esc = await erEscalations(nurse, new Date(Date.now() + 15 * 60000));
    expect(esc.map((e) => e.visitId)).toEqual([c._id]); // level 2 threshold 10 min; level 4 has none configured
    await assignErTeam(doctor, c._id, { doctorId: "doc", nurseId: "nur" });
    expect((await erEscalations(nurse, new Date(Date.now() + 15 * 60000))).length).toBe(0);
  });

  it("disposition rules: triage first, transfer documentation, unknown patients must be linked before admission, admission claims a bed", async () => {
    const v = await registerEr(nurse, { alias: "Unknown female 2", complaint: "Head injury", arrivalMode: "ambulance" });
    await expect(disposeEr(doctor, v._id, { type: "discharge", note: "n" })).rejects.toMatchObject({ code: "CONFLICT" });
    await triage(nurse, v._id, { level: 2 });
    await expect(disposeEr(doctor, v._id, { type: "transfer", note: "to trauma centre" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(disposeEr(doctor, v._id, { type: "admit", note: "obs", bedId: bed2, doctorId: "d" })).rejects.toMatchObject({ code: "CONFLICT" });
    await linkErPatient(nurse, v._id, p3);
    await markBedClean(nurse, bed2).catch(() => undefined);
    await tenantCol<any>(ORG, "admissions").updateMany({ status: "admitted" }, { $set: { status: "discharged" } });
    await tenantCol<any>(ORG, "beds").updateMany({}, { $set: { status: "free" } });
    const r = await disposeEr(doctor, v._id, { type: "admit", note: "Observation after head injury", bedId: bed2, doctorId: "d" });
    expect(r.admissionId).toBeTruthy();
    await expect(disposeEr(doctor, v._id, { type: "discharge", note: "again" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await tenantCol<any>(ORG, "admissions").updateMany({ status: "admitted" }, { $set: { status: "discharged" } });
  });
});

describe("operating theatre", () => {
  let theatre = "", surgeryId = "";
  const at = (h: number, d = 1) => new Date(Date.now() + d * 86400000 + h * 3600_000);

  it("prevents double-booking a theatre, including partial overlaps and parallel attempts", async () => {
    theatre = (await createTheatre(admin, { code: "OT1", name: "Theatre 1" }))._id;
    const s0 = at(0);
    const rs = await Promise.allSettled([
      scheduleSurgery(doctor, { theatreId: theatre, patientId: p3, procedure: "Appendectomy", surgeonId: "s1", start: s0, end: new Date(s0.getTime() + 2 * 3600_000) }),
      scheduleSurgery(doctor, { theatreId: theatre, patientId: p1, procedure: "Hernia repair", surgeonId: "s2", start: new Date(s0.getTime() + 3600_000), end: new Date(s0.getTime() + 3 * 3600_000) }),
    ]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    surgeryId = ((rs.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>).value)._id;
    await expect(scheduleSurgery(doctor, { theatreId: theatre, patientId: p3, procedure: "x", surgeonId: "s", start: s0, end: s0 })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("safety gates: no start without a complete checklist AND a granted surgical consent", async () => {
    const x = await tenantCol<any>(ORG, "surgeries").findOne({ _id: surgeryId });
    await expect(startSurgery(doctor, surgeryId)).rejects.toMatchObject({ code: "CONFLICT" });
    for (let i = 0; i < x.checklist.length; i++) await completeChecklistItem(nurse, surgeryId, i);
    await expect(completeChecklistItem(nurse, surgeryId, 0)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(startSurgery(doctor, surgeryId)).rejects.toMatchObject({ code: "CONFLICT" }); // consent still missing
    await recordSurgeryConsent(doctor, x.patientId);
    await expect(startSurgery(nurse, surgeryId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await startSurgery(doctor, surgeryId);
  });

  it("materials deduct stock and expense it; completion needs recovery observations; theatre fee billed once", async () => {
    const item = (await createItem(im, { sku: "SUT-1", name: "Suture pack", category: "surgical" }))._id;
    await withTransaction(async (s) => {
      const { value } = await receiveIntoStock(im, { itemId: item, locationId: "theatre", batchNo: "T1", expiry: new Date(Date.now() + 300 * 86400000), qty: 20, unitCost: money("15.00"), refType: "t", refId: "t" }, s);
      const { postJournalSystem } = await import("@/modules/ledger/journal");
      const { accountBySystem } = await import("@/modules/ledger/accounts");
      await postJournalSystem(fin, { date: new Date(), memo: "open", sourceRef: { type: "t", id: "t" }, idempotencyKey: "open-sut", lines: [{ accountId: (await accountBySystem(ORG, "inventory_consumables"))._id, debit: value.toFixed(2) }, { accountId: `${ORG}:3000`, credit: value.toFixed(2) }] }, s);
    });
    expect((await useTheatreMaterial(nurse, { surgeryId, itemId: item, qty: 3, locationId: "theatre" })).toFixed(2)).toBe("45.00");
    await expect(completeSurgery(doctor, surgeryId)).rejects.toMatchObject({ code: "CONFLICT" }); // still in theatre
    await expect(moveToRecovery(nurse, surgeryId, " ")).rejects.toMatchObject({ code: "VALIDATION" });
    await moveToRecovery(nurse, surgeryId, "Uneventful; 20 mL blood loss");
    await expect(completeSurgery(doctor, surgeryId)).rejects.toMatchObject({ code: "CONFLICT" }); // no recovery observation yet
    await recordRecoveryObservation(nurse, surgeryId, "Awake, pain 2/10, vitals stable");
    await completeSurgery(doctor, surgeryId);
    const x = await tenantCol<any>(ORG, "surgeries").findOne({ _id: surgeryId });
    expect(x.status).toBe("completed");
    expect((await listUnbilledCharges(reg, x.patientId)).filter((c) => c.serviceCode === "OT-FEE")).toHaveLength(1);
    const tb = await trialBalance(fin, {});
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
  });

  it("only scheduled surgeries cancel; dashboard reflects real counts", async () => {
    const later = await scheduleSurgery(doctor, { theatreId: theatre, patientId: p1, procedure: "Biopsy", surgeonId: "s1", start: at(0, 3), end: at(1, 3) });
    await expect(cancelSurgery(doctor, later._id, " ")).rejects.toMatchObject({ code: "VALIDATION" });
    await cancelSurgery(doctor, later._id, "Patient unwell");
    await expect(cancelSurgery(doctor, surgeryId, "late")).rejects.toMatchObject({ code: "CONFLICT" });
    const d = await hospitalDashboard(doctor);
    expect(d.beds).toBe(2);
  });
});
