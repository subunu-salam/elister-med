import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { toDecimal128, money, fromDecimal128 } from "@/core/money";
import { ctxFor } from "@/test/helpers";
import { createPatient } from "@/modules/patients/service";
import { bookAppointment } from "@/modules/appointments/service";
import { checkIn } from "@/modules/queue/service";
import { openEncounter, saveDraftNote, signNote, completeEncounter } from "@/modules/emr/service";
import { addCharge, listUnbilledCharges } from "./charges";

const ORG = "org-charges";
const reg = ctxFor(["receptionist"], ORG, "recep", "br1");
const doctor = ctxFor(["doctor"], ORG, "doc-user", "br1");
const DOC = "cdoc-1";

beforeAll(async () => {
  await ensureIndexes();
  await tenantCol<any>(ORG, "staff").insertOne({
    _id: DOC, userKey: "c", userId: "doc-user", name: "Dr C", departmentId: "dept-gp", workDays: [1, 2, 3, 4, 5],
    workStart: "09:00", workEnd: "17:00", slotMinutes: 20, branchId: "br1", active: true,
  });
  await tenantCol<any>(ORG, "tax_codes").insertOne({ _id: "t-std", code: "STD", rate: toDecimal128(money("5")), kind: "standard", reviewRequired: true });
  await tenantCol<any>(ORG, "services").insertOne({
    _id: "svc-cons", code: "CONS-GP", name: "GP Consultation", departmentId: "dept-gp", kind: "consultation",
    price: toDecimal128(money("250.00")), taxCode: "STD", revenueAccountSystem: "rev_consultation", isDefaultConsultation: true, active: true,
  });
  await tenantCol<any>(ORG, "services").insertOne({
    _id: "svc-lab", code: "LAB-CBC", name: "CBC", departmentId: "dept-lab", kind: "lab",
    price: toDecimal128(money("90.00")), taxCode: "STD", revenueAccountSystem: "rev_laboratory", isDefaultConsultation: false, active: true,
  });
});
afterAll(async () => { await closeClient(); });

async function completedEncounter(i: number) {
  const p = await createPatient(reg, { fullName: `Charge Patient ${i}`, dob: "1975-03-03", sex: "male", phone: `+9715440${3000 + i}` });
  const start = new Date(`2026-11-09T${String(9 + i).padStart(2, "0")}:00:00+04:00`);
  const a = await bookAppointment(reg, { patientId: p._id, doctorId: DOC, start, end: new Date(start.getTime() + 600000) });
  await checkIn(reg, a._id);
  const w = await openEncounter(doctor, a._id);
  await saveDraftNote(doctor, w.note._id, { s: "s", o: "o", a: "a", p: "p" });
  await signNote(doctor, w.note._id);
  return { p, w };
}

describe("charges", () => {
  it("completing an encounter yields exactly one consultation charge, even when called twice", async () => {
    const { p, w } = await completedEncounter(0);
    await completeEncounter(doctor, w.encounter._id);
    await completeEncounter(doctor, w.encounter._id);
    const list = await listUnbilledCharges(reg, p._id);
    const cons = list.filter((c) => c.kind === "consultation");
    expect(cons).toHaveLength(1);
    expect(fromDecimal128(cons[0].unitPrice).toFixed(2)).toBe("250.00");
    expect(fromDecimal128(cons[0].taxRate).toFixed(0)).toBe("5");
    expect(cons[0].status).toBe("unbilled");
  });

  it("addCharge snapshots price/tax; qty must be a positive integer; role checked", async () => {
    const { p, w } = await completedEncounter(1);
    const c = await addCharge(reg, { encounterId: w.encounter._id, serviceId: "svc-lab", qty: 2 });
    expect(fromDecimal128(c.unitPrice).toFixed(2)).toBe("90.00");
    expect(c.qty).toBe(2);
    await expect(addCharge(reg, { encounterId: w.encounter._id, serviceId: "svc-lab", qty: 0 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(addCharge(reg, { encounterId: w.encounter._id, serviceId: "nope", qty: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(addCharge(ctxFor(["pharmacist"], ORG), { encounterId: w.encounter._id, serviceId: "svc-lab", qty: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await listUnbilledCharges(reg, p._id)).length).toBe(1);
  });

  it("org isolation", async () => {
    const { p } = await completedEncounter(2);
    expect(await listUnbilledCharges(ctxFor(["receptionist"], "other-org"), p._id)).toHaveLength(0);
  });
});
