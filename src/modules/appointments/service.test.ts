import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol, withTransaction } from "@/core/db";
import { ctxFor } from "@/test/helpers";
import { createPatient } from "@/modules/patients/service";
import {
  bookAppointment, rescheduleAppointment, cancelAppointment, markNoShow, transitionAppointment,
} from "./service";

const ORG = "org-appt";
const reg = ctxFor(["receptionist"], ORG);
const DOC = "doc-1";
let patientId = "";

// Monday 2026-11-09. Dubai is UTC+4, so 10:00 Dubai = 06:00Z.
const at = (hhmmDubai: string, day = "2026-11-09") => new Date(`${day}T${hhmmDubai}:00+04:00`);

beforeAll(async () => {
  await ensureIndexes();
  await tenantCol<any>(ORG, "staff").insertOne({
    _id: DOC, userKey: "d1", name: "Dr Test", workDays: [1, 2, 3, 4, 5], workStart: "09:00", workEnd: "17:00",
    slotMinutes: 20, branchId: "b1", active: true,
  });
  const p = await createPatient(reg, { fullName: "Appt Patient", dob: "1990-01-01", sex: "female", phone: "+971500000001" });
  patientId = p._id;
});
afterAll(async () => { await closeClient(); });

const book = (start: Date, end: Date, ctx = reg) => bookAppointment(ctx, { patientId, doctorId: DOC, start, end });

describe("booking", () => {
  it("10 parallel books of the same slot -> exactly 1 success, 9 CONFLICT", async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => book(at("10:00"), at("10:20"))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(9);
    for (const r of rejected) expect(r.reason).toMatchObject({ code: "CONFLICT" });
  });

  it("partially overlapping parallel bookings -> only one wins", async () => {
    const results = await Promise.allSettled([book(at("11:00"), at("11:30")), book(at("11:15"), at("11:45"))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("allows back-to-back slots", async () => {
    await book(at("12:00"), at("12:20"));
    await expect(book(at("12:20"), at("12:40"))).resolves.toBeTruthy();
  });

  it("rejects outside hours and non-working days", async () => {
    await expect(book(at("08:00"), at("08:20"))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(book(at("16:50"), at("17:10"))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(book(at("10:00", "2026-11-14"), at("10:20", "2026-11-14"))).rejects.toMatchObject({ code: "CONFLICT" }); // Saturday
  });

  it("leave and holiday block booking", async () => {
    await tenantCol<any>(ORG, "time_off").insertOne({ _id: "leave1", doctorId: DOC, start: at("09:00", "2026-11-10"), end: at("17:00", "2026-11-10"), reason: "annual", kind: "leave" });
    await tenantCol<any>(ORG, "time_off").insertOne({ _id: "hol1", doctorId: null, start: at("09:00", "2026-11-11"), end: at("17:00", "2026-11-11"), reason: "national day", kind: "holiday" });
    await expect(book(at("10:00", "2026-11-10"), at("10:20", "2026-11-10"))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(book(at("10:00", "2026-11-11"), at("10:20", "2026-11-11"))).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("forbids unauthorised role", async () => {
    await expect(book(at("13:00"), at("13:20"), ctxFor(["accountant"], ORG))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("org isolation: other org cannot book against this org's doctor or patient", async () => {
    await expect(bookAppointment(ctxFor(["receptionist"], "other-org"), { patientId, doctorId: DOC, start: at("13:00"), end: at("13:20") }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("lifecycle", () => {
  it("reschedule moves the slot and frees the old one; clash is rejected", async () => {
    const a = await book(at("14:00"), at("14:20"));
    const b = await book(at("14:20"), at("14:40"));
    await expect(rescheduleAppointment(reg, a._id, at("14:20"), at("14:40"))).rejects.toMatchObject({ code: "CONFLICT" });
    await rescheduleAppointment(reg, a._id, at("15:00"), at("15:20"));
    await expect(book(at("14:00"), at("14:20"))).resolves.toBeTruthy();
    void b;
  });

  it("cancelled slot can be rebooked; cancel requires a reason", async () => {
    const a = await book(at("15:30"), at("15:50"));
    await expect(cancelAppointment(reg, a._id, " ")).rejects.toMatchObject({ code: "VALIDATION" });
    await cancelAppointment(reg, a._id, "patient request");
    await expect(book(at("15:30"), at("15:50"))).resolves.toBeTruthy();
  });

  it("invalid transitions are rejected", async () => {
    const a = await book(at("16:00"), at("16:20"));
    await markNoShow(reg, a._id);
    await expect(withTransaction((s) => transitionAppointment(reg, a._id, "checked_in", s))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(cancelAppointment(reg, a._id, "x")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("writes audit rows", async () => {
    const a = await book(at("16:30"), at("16:40"));
    const rows = await tenantCol<any>(ORG, "audit_log").find({ resourceId: a._id });
    expect(rows.map((r) => r.action)).toContain("appointment.book");
  });
});
