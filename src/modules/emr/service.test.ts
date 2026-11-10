import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { ctxFor } from "@/test/helpers";
import { createPatient } from "@/modules/patients/service";
import { bookAppointment } from "@/modules/appointments/service";
import { checkIn } from "@/modules/queue/service";
import {
  openEncounter, getWorkspace, saveDraftNote, signNote, amendNote, addDiagnosis, recordVitals, completeEncounter,
} from "./service";

const ORG = "org-emr";
const reg = ctxFor(["receptionist"], ORG, "recep-1", "br1");
const doctor = ctxFor(["doctor"], ORG, "doc-user", "br1");
const otherDoctor = ctxFor(["doctor"], ORG, "doc-other", "br1");
const nurse = ctxFor(["nurse"], ORG, "nurse-1", "br1");
const DOC = "edoc-1";
let slot = 0;

async function readyEncounter() {
  const mm = String(slot * 10).padStart(2, "0");
  const hh = String(9 + Math.floor((slot * 10) / 60)).padStart(2, "0");
  const mmm = String((slot * 10) % 60).padStart(2, "0");
  void mm;
  slot++;
  const p = await createPatient(reg, {
    fullName: `Emr Patient ${slot}`, dob: "1980-05-05", sex: "female", phone: `+9715330${2000 + slot}`,
    allergies: [{ substance: "Penicillin", reaction: "rash", severity: "severe" }], alerts: ["Anticoagulant therapy"],
  });
  const start = new Date(`2026-11-09T${hh}:${mmm}:00+04:00`);
  const a = await bookAppointment(reg, { patientId: p._id, doctorId: DOC, start, end: new Date(start.getTime() + 9 * 60000) });
  await checkIn(reg, a._id);
  return { p, a };
}

beforeAll(async () => {
  await ensureIndexes();
  await tenantCol<any>(ORG, "staff").insertOne({
    _id: DOC, userKey: "ed", userId: "doc-user", name: "Dr Emr", workDays: [1, 2, 3, 4, 5], workStart: "09:00", workEnd: "17:00",
    slotMinutes: 20, branchId: "br1", active: true,
  });
});
afterAll(async () => { await closeClient(); });

describe("encounter", () => {
  it("only the assigned doctor opens the encounter; open is idempotent", async () => {
    const { a } = await readyEncounter();
    await expect(openEncounter(otherDoctor, a._id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(openEncounter(nurse, a._id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const w1 = await openEncounter(doctor, a._id);
    const w2 = await openEncounter(doctor, a._id);
    expect(w2.encounter._id).toBe(w1.encounter._id);
    const appt = await tenantCol<any>(ORG, "appointments").findOne({ _id: a._id });
    expect(appt.status).toBe("in_consult");
  });

  it("workspace surfaces allergy and medical alerts, and every read is audited", async () => {
    const { a } = await readyEncounter();
    const w = await openEncounter(doctor, a._id);
    const again = await getWorkspace(doctor, w.encounter._id);
    expect(again.alerts.allergies[0]).toMatchObject({ substance: "Penicillin", severity: "severe" });
    expect(again.alerts.medical).toContain("Anticoagulant therapy");
    const rows = await tenantCol<any>(ORG, "audit_log").find({ resourceId: w.encounter._id, action: "emr.read" });
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("signed note cannot be edited; amend creates v2, keeps v1 and links it", async () => {
    const { a } = await readyEncounter();
    const w = await openEncounter(doctor, a._id);
    const noteId = w.note._id;
    await saveDraftNote(doctor, noteId, { s: "cough", o: "clear chest", a: "URTI", p: "rest" });
    await signNote(doctor, noteId);
    await expect(saveDraftNote(doctor, noteId, { s: "tamper", o: "", a: "", p: "" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(amendNote(doctor, noteId, { s: "cough 3d", o: "clear chest", a: "URTI", p: "rest" }, " ")).rejects.toMatchObject({ code: "VALIDATION" });
    const v2 = await amendNote(doctor, noteId, { s: "cough 3d", o: "clear chest", a: "URTI", p: "rest" }, "added duration");
    expect(v2.version).toBe(2);
    expect(v2.supersedes).toBe(noteId);
    const notes = await tenantCol<any>(ORG, "notes").find({ encounterId: w.encounter._id }, { sort: { version: 1 } });
    expect(notes.map((n) => [n.version, n.status])).toEqual([[1, "superseded"], [2, "signed"]]);
    expect(notes[0].soap.s).toBe("cough"); // v1 content preserved
  });

  it("non-doctor cannot sign", async () => {
    const { a } = await readyEncounter();
    const w = await openEncounter(doctor, a._id);
    await expect(signNote(nurse, w.note._id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("nurse records vitals; doctor adds diagnosis; validation applies", async () => {
    const { a } = await readyEncounter();
    const w = await openEncounter(doctor, a._id);
    await recordVitals(nurse, w.encounter._id, { systolic: 120, diastolic: 80, heartRate: 72, tempC: 36.8, spo2: 98 });
    await expect(recordVitals(nurse, w.encounter._id, { systolic: 900 } as any)).rejects.toMatchObject({ code: "VALIDATION" });
    await addDiagnosis(doctor, w.encounter._id, { code: "J06.9", description: "Acute upper respiratory infection", primary: true });
    const got = await getWorkspace(doctor, w.encounter._id);
    expect(got.encounter.vitals).toHaveLength(1);
    expect(got.encounter.diagnoses[0].code).toBe("J06.9");
  });

  it("complete requires signed note; completes appointment and token; second call is a no-op", async () => {
    const { a } = await readyEncounter();
    const w = await openEncounter(doctor, a._id);
    await expect(completeEncounter(doctor, w.encounter._id)).rejects.toMatchObject({ code: "CONFLICT" });
    await saveDraftNote(doctor, w.note._id, { s: "s", o: "o", a: "a", p: "p" });
    await signNote(doctor, w.note._id);
    const c1 = await completeEncounter(doctor, w.encounter._id);
    const c2 = await completeEncounter(doctor, w.encounter._id);
    expect(c1.status).toBe("completed");
    expect(c2.status).toBe("completed");
    expect((await tenantCol<any>(ORG, "appointments").findOne({ _id: a._id })).status).toBe("completed");
    expect((await tenantCol<any>(ORG, "queue_tokens").findOne({ appointmentId: a._id })).status).toBe("done");
  });

  it("org isolation on workspace", async () => {
    const { a } = await readyEncounter();
    const w = await openEncounter(doctor, a._id);
    await expect(getWorkspace(ctxFor(["doctor"], "other-org", "doc-user"), w.encounter._id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
