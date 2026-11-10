import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { ctxFor } from "@/test/helpers";
import { createPatient } from "@/modules/patients/service";
import { bookAppointment } from "@/modules/appointments/service";
import { subscribe } from "@/core/bus";
import { checkIn, callNext, skipToken, estimateWaitMinutes, publicBoard } from "./service";

const ORG = "org-queue";
const reg = ctxFor(["receptionist"], ORG, "u1", "br1");
const DOC = "qdoc-1";
const at = (hhmm: string) => new Date(`2026-11-09T${hhmm}:00+04:00`);
let n = 0;

async function makeAppt(hh: string, mm: string) {
  const p = await createPatient(reg, { fullName: `Queue Person ${n++}`, dob: "1991-02-02", sex: "male", phone: `+9715110${1000 + n}` });
  return bookAppointment(reg, { patientId: p._id, doctorId: DOC, start: at(`${hh}:${mm}`), end: at(`${hh}:${String(Number(mm) + 5).padStart(2, "0")}`) });
}

beforeAll(async () => {
  await ensureIndexes();
  await tenantCol<any>(ORG, "staff").insertOne({
    _id: DOC, userKey: "qd", name: "Dr Queue", workDays: [1, 2, 3, 4, 5], workStart: "09:00", workEnd: "17:00",
    slotMinutes: 20, branchId: "br1", active: true,
  });
});
afterAll(async () => { await closeClient(); });

describe("queue", () => {
  it("token numbers are unique and sequential under parallel check-in", async () => {
    const appts = [];
    for (let i = 0; i < 5; i++) appts.push(await makeAppt("10", String(i * 6).padStart(2, "0")));
    const tokens = await Promise.all(appts.map((a) => checkIn(reg, a._id)));
    const nums = tokens.map((t) => t.number).sort((a, b) => a - b);
    expect(nums).toEqual([1, 2, 3, 4, 5]);
  });

  it("check-in of a non-booked appointment is rejected (no double token)", async () => {
    const a = await makeAppt("11", "00");
    await checkIn(reg, a._id);
    await expect(checkIn(reg, a._id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("callNext honours priority then token order; skip works", async () => {
    const doc = "qdoc-2";
    await tenantCol<any>(ORG, "staff").insertOne({ _id: doc, userKey: "q2", name: "Dr Two", workDays: [1], workStart: "09:00", workEnd: "17:00", slotMinutes: 20, branchId: "br1", active: true });
    const mk = async (hh: string) => {
      const p = await createPatient(reg, { fullName: `Prio ${hh}`, dob: "1991-02-02", sex: "male", phone: `+9715220${hh}00` });
      return bookAppointment(reg, { patientId: p._id, doctorId: doc, start: at(`${hh}:00`), end: at(`${hh}:10`) });
    };
    const a1 = await mk("12"), a2 = await mk("13");
    const t1 = await checkIn(reg, a1._id);
    const t2 = await checkIn(reg, a2._id, { priority: 1 });
    const first = await callNext(reg, doc);
    expect(first?._id).toBe(t2._id);
    await skipToken(reg, first!._id);
    const second = await callNext(reg, doc);
    expect(second?._id).toBe(t1._id);
    expect(await callNext(reg, doc)).toBeNull();
  });

  it("wait estimate uses actual completed consult durations", async () => {
    const doc = "qdoc-3";
    await tenantCol<any>(ORG, "staff").insertOne({ _id: doc, userKey: "q3", name: "Dr Three", workDays: [1], workStart: "09:00", workEnd: "17:00", slotMinutes: 20, branchId: "br1", active: true });
    expect(await estimateWaitMinutes(reg, doc)).toBe(0); // nobody waiting
    const base = new Date("2026-11-09T06:00:00Z");
    for (let i = 0; i < 3; i++)
      await tenantCol<any>(ORG, "queue_tokens").insertOne({ _id: `done${i}`, doctorId: doc, status: "done", branchId: "br1", day: "2026-11-09", number: 100 + i, startedAt: base, completedAt: new Date(base.getTime() + 10 * 60000) });
    await tenantCol<any>(ORG, "queue_tokens").insertOne({ _id: "w1", doctorId: doc, status: "waiting", branchId: "br1", day: "2026-11-09", number: 200, priority: 0, checkedInAt: new Date() });
    await tenantCol<any>(ORG, "queue_tokens").insertOne({ _id: "w2", doctorId: doc, status: "waiting", branchId: "br1", day: "2026-11-09", number: 201, priority: 0, checkedInAt: new Date() });
    expect(await estimateWaitMinutes(reg, doc)).toBe(20); // 2 waiting x 10 min actual average
  });

  it("SSE bus: org B never receives org A events", async () => {
    const gotB: unknown[] = [], gotA: unknown[] = [];
    const offB = subscribe("org-queue-B", (e) => gotB.push(e));
    const offA = subscribe(ORG, (e) => gotA.push(e));
    const a = await makeAppt("14", "00");
    await checkIn(reg, a._id);
    offA(); offB();
    expect(gotA.length).toBeGreaterThan(0);
    expect(gotB).toHaveLength(0);
  });

  it("public display payload has no patient fields", async () => {
    const board = await publicBoard(ORG, "br1");
    expect(board.length).toBeGreaterThan(0);
    for (const row of board) {
      expect(Object.keys(row).sort()).toEqual(["doctorLabel", "number", "status"]);
    }
    expect(JSON.stringify(board)).not.toMatch(/Queue Person|patientId|phone|mrn/i);
  });
});
