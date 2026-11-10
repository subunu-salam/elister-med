import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, getDb, tenantCol } from "@/core/db";
import { ctxFor } from "@/test/helpers";
import { createPatient, searchPatients, getPatient } from "./service";

const reg = ctxFor(["receptionist"], "org-pt-a");
const regB = ctxFor(["receptionist"], "org-pt-b");
const base = { fullName: "Mohammed Al Mansoori", dob: "1985-04-12", sex: "male" as const, phone: "+971501234567" };

beforeAll(async () => { await ensureIndexes(); });
afterAll(async () => { await closeClient(); });

describe("patients", () => {
  it("20 parallel creates give 20 unique sequential MRNs", async () => {
    const ps = await Promise.all(Array.from({ length: 20 }, (_, i) => createPatient(reg, { ...base, fullName: `Patient ${i}`, phone: `+97150000${100 + i}` })));
    const nums = ps.map((p) => Number(p.mrn.replace("MRN-", ""))).sort((a, b) => a - b);
    expect(new Set(nums).size).toBe(20);
    expect(nums[19] - nums[0]).toBe(19);
  });
  it("org isolation: org B cannot read org A patient", async () => {
    const p = await createPatient(reg, { ...base, fullName: "Isolated One", phone: "+971509990001" });
    await expect(getPatient(regB, p._id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await searchPatients(regB, "Isolated")).length).toBe(0);
  });
  it("Emirates ID encrypted at rest, masked on read", async () => {
    const p = await createPatient(reg, { ...base, fullName: "Enc Test", phone: "+971509990002", emiratesId: "784-1985-1234567-1" });
    const raw = await (await getDb()).collection<any>("patients").findOne({ _id: p._id });
    expect(JSON.stringify(raw)).not.toContain("1234567");
    expect(raw.emiratesIdEnc).toBeTruthy();
    const got = await getPatient(reg, p._id);
    expect(got.emiratesIdMasked).toBe("784-****-*******-1");
    expect((got as any).emiratesId).toBeUndefined();
  });
  it("Arabic name searchable; MRN and phone searchable", async () => {
    const p = await createPatient(reg, { ...base, fullName: "Khalid Saeed", fullNameAr: "خالد سعيد", phone: "+971509990003" });
    expect((await searchPatients(reg, "خالد")).map((h) => h._id)).toContain(p._id);
    expect((await searchPatients(reg, p.mrn)).map((h) => h._id)).toContain(p._id);
    expect((await searchPatients(reg, "509990003")).map((h) => h._id)).toContain(p._id);
  });
  it("flags duplicates by Emirates ID and by name+dob", async () => {
    const a = await createPatient(reg, { ...base, fullName: "Dup Person", phone: "+971509990010", emiratesId: "784-1990-7654321-1" });
    const b = await createPatient(reg, { ...base, fullName: "Dup Person", phone: "+971509990011", emiratesId: "784-1990-7654321-1" });
    expect(b.duplicateOf).toContain(a._id);
    const c = await createPatient(reg, { ...base, fullName: "Dup Person", phone: "+971509990012" });
    expect(c.duplicateOf.length).toBeGreaterThan(0);
  });
  it("writes audit rows for create and read", async () => {
    const p = await createPatient(reg, { ...base, fullName: "Audit Me", phone: "+971509990020" });
    await getPatient(reg, p._id);
    const rows = await tenantCol<any>("org-pt-a", "audit_log").find({ resourceId: p._id });
    expect(rows.map((r) => r.action).sort()).toEqual(["patient.create", "patient.read"]);
  });
  it("forbids roles without permission and rejects invalid input", async () => {
    await expect(createPatient(ctxFor(["accountant"], "org-pt-a"), base)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createPatient(reg, { ...base, fullName: "", phone: "x" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
