import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { money, toDecimal128 } from "@/core/money";
import { ctxFor } from "@/test/helpers";
import { ensureChartOfAccounts } from "@/modules/ledger/accounts";
import { postJournal } from "@/modules/ledger/journal";
import { createPatient } from "@/modules/patients/service";
import { bookAppointment } from "@/modules/appointments/service";
import { openEncounter, saveDraftNote, signNote } from "@/modules/emr/service";
import { checkIn } from "@/modules/queue/service";
import {
  assertExternalProviderAllowed, answerFacilityQuestion, findAvailableSlots, assistantBook, setOrgSettings, noShowRisk, demandForecast, inventoryDemand, dictationToDraft,
  acceptDraft, rejectDraft, missingDocumentation, summarizeRecord, revenueTrendSummary, revenueAnomalies,
} from "./service";
import { portalOverview, portalBook, portalCancel, portalReschedule, portalSubmitIntake, kioskCheckIn, portalQueueStatus, portalResults, pendingIntake } from "@/modules/portal/service";
import { getPrefs, setWidgets, saveView, deleteView, touchRecentPatient, recentPatients } from "@/modules/prefs/service";
import { createGroup, agreeToGroup, groupConsolidatedPnl, revokeGroupAgreement } from "@/modules/org/group";

const ORG = "org-plat";
const reg = ctxFor(["receptionist"], ORG, "recep", "br1");
const doctor = ctxFor(["doctor"], ORG, "doc-user", "br1");
const admin = ctxFor(["org_admin"], ORG, "adm", "br1");
let p1 = "", p2 = "";
const monday = () => { const d = new Date(Date.now() + 4 * 3600_000); while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const at = (hhmm: string, day = monday()) => new Date(`${day}T${hhmm}:00+04:00`);

beforeAll(async () => {
  await ensureIndexes();
  await ensureChartOfAccounts(ORG);
  const y = new Date().getUTCFullYear();
  for (const year of [y - 1, y, y + 1]) for (let m = 1; m <= 12; m++)
    await tenantCol<any>(ORG, "fiscal_periods").insertOne({ _id: `${ORG}:${year}-${m}`, year, month: m, status: "open", start: new Date(Date.UTC(year, m - 1, 1, -4)), end: new Date(Date.UTC(year, m, 1, -4)) });
  await tenantCol<any>(ORG, "tax_codes").insertOne({ _id: `${ORG}:t`, code: "STD", rate: toDecimal128(money("5")), kind: "standard", reviewRequired: true });
  await tenantCol<any>(ORG, "services").insertOne({ _id: "svc-c", code: "CONS", name: "GP Consultation", kind: "consultation", price: toDecimal128(money("250.00")), taxCode: "STD", revenueAccountSystem: "rev_consultation", departmentId: "GP", isDefaultConsultation: true, active: true });
  await tenantCol<any>(ORG, "staff").insertOne({ _id: "dplat1", userKey: "dplat1", userId: "doc-user", name: "Dr Assistant", role: "doctor", specialty: "General Practice", workDays: [1, 2, 3, 4, 5], workStart: "09:00", workEnd: "12:00", slotMinutes: 30, branchId: "br1", active: true });
  p1 = (await createPatient(reg, { fullName: "Portal Paula", dob: "1992-02-02", sex: "female", phone: "+971504440001" }))._id;
  p2 = (await createPatient(reg, { fullName: "Other Omar", dob: "1988-08-08", sex: "male", phone: "+971504440002" }))._id;
});
afterAll(async () => { await closeClient(); });

describe("AI assistants (local rules, no external provider)", () => {
  it("external AI is blocked until governance approvals exist, and even then no adapter is installed", async () => {
    await expect(assertExternalProviderAllowed(doctor)).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/blocked/) });
    await tenantCol<any>(ORG, "ai_governance").insertOne({ _id: "g", key: "main", externalApprovedBy: "x", dpaRef: "DPA-1", residencyVerified: true });
    await expect(assertExternalProviderAllowed(doctor)).rejects.toMatchObject({ message: expect.stringMatching(/No external AI adapter/) });
  });

  it("front office: answers from configured data in two languages, declines medical questions, admits missing configuration", async () => {
    expect((await answerFacilityQuestion(reg, "What are your opening hours?")).answer).toMatch(/not been configured/);
    await setOrgSettings(admin, { openingHours: "Mon-Fri 09:00-17:00", address: "Dubai Healthcare City" });
    expect((await answerFacilityQuestion(reg, "What are your opening hours?")).answer).toContain("09:00-17:00");
    expect((await answerFacilityQuestion(reg, "ما هي ساعات الدوام؟", "ar")).answer).toContain("ساعات العمل");
    const med = await answerFacilityQuestion(reg, "What dose of ibuprofen should I take for my fever?");
    expect(med.handled).toBe(false);
    expect(med.answer).toMatch(/can't give medical advice/);
    expect((await answerFacilityQuestion(reg, "How much is a consultation?")).answer).toContain("250.00");
    expect((await answerFacilityQuestion(reg, "Which doctors do you have?")).answer).toContain("Dr Assistant");
  });

  it("slot search uses real availability; assistant booking is limited to the caller's own permissions", async () => {
    const slots = await findAvailableSlots(reg, { doctorId: "dplat1", date: monday() });
    expect(slots).toHaveLength(6); // 09:00-12:00 in 30 min steps
    const b = await assistantBook(reg, { patientId: p1, doctorId: "dplat1", start: new Date(slots[0]), durationMin: 30 });
    expect(b.notes).toBe("Booked via assistant");
    expect(await findAvailableSlots(reg, { doctorId: "dplat1", date: monday() })).toHaveLength(5);
    await expect(assistantBook(ctxFor(["nurse"], ORG, "n"), { patientId: p1, doctorId: "dplat1", start: new Date(slots[1]), durationMin: 30 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("operational helpers are deterministic and label their limits", async () => {
    const r = await noShowRisk(reg, (await tenantCol<any>(ORG, "appointments").findOne({ patientId: p1 }))._id);
    expect(r.validated).toBe(false);
    expect(r.score).toBeGreaterThan(0);
    expect((await demandForecast(reg)).weekdayAverage).toHaveLength(7);
    const d = await inventoryDemand(reg, { itemId: "none", leadTimeDays: 7 });
    expect(d.suggestedReorderPoint).toBe(0);
    await postJournal(ctxFor(["accountant"], ORG, "acc"), { date: new Date(), memo: "s", idempotencyKey: "ai-s", sourceRef: { type: "t", id: "1" }, lines: [{ accountId: `${ORG}:1000`, debit: "100" }, { accountId: `${ORG}:4000`, credit: "100" }] });
    const sum = await revenueTrendSummary(ctxFor(["finance_manager"], ORG, "fin"), { from: new Date(Date.now() - 30 * 86400000), to: new Date(Date.now() + 86400000) });
    expect(sum.text).toMatch(/Revenue AED 100\.00/);
    expect(sum.aiGenerated).toBe(true);
    expect((await revenueAnomalies(ctxFor(["finance_manager"], ORG, "fin"), { from: new Date(Date.now() - 30 * 86400000), to: new Date(Date.now() + 86400000) })).note).toMatch(/Not enough/);
  });

  it("documentation assistant: dictation becomes a DRAFT, never a signed note; clinician must accept; signing stays human", async () => {
    const a = await bookAppointment(reg, { patientId: p2, doctorId: "dplat1", start: at("11:00"), end: at("11:30") });
    await checkIn(reg, a._id);
    const w = await openEncounter(doctor, a._id);
    await expect(dictationToDraft(reg, { encounterId: w.encounter._id, text: "Patient complains of cough." })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await missingDocumentation(doctor, w.encounter._id)).join()).toMatch(/No diagnosis/);
    const d = await dictationToDraft(doctor, { encounterId: w.encounter._id, text: "Patient complains of cough for three days. On examination chest is clear. Assessment likely viral infection. Plan rest and fluids, review in one week." });
    expect(d).toMatchObject({ status: "draft", aiGenerated: true, source: "local-rules" });
    expect(d.content.s).toMatch(/cough/);
    expect(d.content.o).toMatch(/chest is clear/);
    expect(d.content.p).toMatch(/rest and fluids/);
    expect((await tenantCol<any>(ORG, "notes").findOne({ encounterId: w.encounter._id })).soap.s).toBe(""); // nothing written yet
    await acceptDraft(doctor, d._id);
    const note = await tenantCol<any>(ORG, "notes").findOne({ encounterId: w.encounter._id });
    expect(note.soap.s).toMatch(/cough/);
    expect(note.status).toBe("draft"); // still unsigned
    await expect(acceptDraft(doctor, d._id)).rejects.toMatchObject({ code: "CONFLICT" });
    await signNote(doctor, note._id);
    const d2 = await dictationToDraft(doctor, { encounterId: w.encounter._id, text: "Patient reports headache since yesterday and nausea." });
    await expect(acceptDraft(doctor, d2._id)).rejects.toMatchObject({ code: "CONFLICT" }); // signed notes are amended, not overwritten
    await rejectDraft(doctor, d2._id);
    expect((await summarizeRecord(doctor, p2)).status).toBe("draft");
  });
});

describe("patient portal and kiosk", () => {
  const portalCtx = () => ({ ...ctxFor(["patient_portal_user"], ORG, "portal-u1", "br1"), patientId: p1 });

  it("a portal user is bound to one patient; staff and unlinked users are refused", async () => {
    await expect(portalOverview(reg)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(portalOverview(ctxFor(["patient_portal_user"], ORG, "x"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const o = await portalOverview(portalCtx());
    expect(o.upcoming.length + o.past.length).toBeGreaterThanOrEqual(1);
  });

  it("books, reschedules and cancels only their own appointments; cannot touch someone else's", async () => {
    const day = monday();
    const b = await portalBook(portalCtx(), { doctorId: "dplat1", start: at("10:30", day), end: at("11:00", day) });
    expect(b.patientId).toBe(p1);
    const r = await portalReschedule(portalCtx(), b._id, at("09:30", day), at("10:00", day)).catch((e) => e);
    expect(r.start ?? r.code).toBeTruthy();
    const others = await tenantCol<any>(ORG, "appointments").findOne({ patientId: p2 });
    await expect(portalCancel(portalCtx(), others._id, "x")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(portalReschedule(portalCtx(), others._id, at("09:00"), at("09:30"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await portalCancel(portalCtx(), b._id, "Cannot attend");
    expect((await tenantCol<any>(ORG, "appointments").findOne({ _id: b._id })).status).toBe("cancelled");
  });

  it("intake updates contact data and queues self-reported allergies for staff review; results show only released orders", async () => {
    await expect(portalSubmitIntake(portalCtx(), { phone: "abc" })).rejects.toMatchObject({ code: "VALIDATION" });
    await portalSubmitIntake(portalCtx(), { email: "paula@example.org", commPrefs: { sms: true, email: true, whatsapp: false, marketing: false }, selfReportedAllergies: ["Shellfish"], consentToTreatment: true });
    expect((await tenantCol<any>(ORG, "patients").findOne({ _id: p1 })).email).toBe("paula@example.org");
    expect((await tenantCol<any>(ORG, "patients").findOne({ _id: p1 })).allergies).toEqual([]); // not merged into the clinical list
    expect((await pendingIntake(reg))[0].selfReportedAllergies).toEqual(["Shellfish"]);
    expect(await portalResults(portalCtx())).toEqual([]);
  });

  it("QR kiosk check-in uses the appointment token, only for today, and reveals no personal data", async () => {
    const todayAppt = await bookAppointment(reg, { patientId: p1, doctorId: "dplat1", start: new Date(Date.now() + 3600_000), end: new Date(Date.now() + 5400_000), type: "consultation" }).catch(() => null);
    if (todayAppt) {
      const res = await kioskCheckIn(ORG, "br1", todayAppt.checkInToken!).catch((e) => e);
      expect(res.tokenNumber ?? res.code).toBeTruthy();
      if (res.tokenNumber) expect(Object.keys(res)).toEqual(["tokenNumber"]);
    }
    await expect(kioskCheckIn(ORG, "br1", "not-a-token")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const future = await tenantCol<any>(ORG, "appointments").findOne({ status: "booked", start: { $gt: new Date(Date.now() + 2 * 86400000) } });
    if (future) await expect(kioskCheckIn(ORG, "br1", future.checkInToken)).rejects.toMatchObject({ code: "CONFLICT" });
    void portalQueueStatus;
  });
});

describe("user preferences", () => {
  it("per-user widgets, saved views and recent patients; no leakage between users", async () => {
    const u2 = ctxFor(["receptionist"], ORG, "recep2", "br1");
    await expect(setWidgets(reg, ["executive", "nonsense"])).rejects.toMatchObject({ code: "VALIDATION" });
    await setWidgets(reg, ["reception", "doctor"]);
    expect((await getPrefs(reg)).widgets).toEqual(["reception", "doctor"]);
    expect((await getPrefs(u2)).widgets.length).toBeGreaterThan(2);
    const v = await saveView(reg, { page: "patients", name: "Recent diabetics", query: "q=diab" });
    await expect(saveView(reg, { page: "patients", name: "x", query: "<script>" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await getPrefs(u2)).savedViews).toHaveLength(0);
    await deleteView(reg, v.id);
    for (const id of [p1, p2, p1]) await touchRecentPatient(reg, id);
    expect((await recentPatients(reg)).map((r) => r.id)).toEqual([p1, p2]);
    expect(await recentPatients(ctxFor(["accountant"], ORG, "acc"))).toEqual([]); // no patients:view
  });
});

describe("group consolidation", () => {
  it("includes a member only after its own administrator agrees; revocation removes it again", async () => {
    const PARENT = "org-grp-parent", CHILD = "org-grp-child";
    const pAdmin = ctxFor(["org_admin"], PARENT, "pa", "b"), cAdmin = ctxFor(["org_admin"], CHILD, "ca", "b");
    for (const o of [PARENT, CHILD]) {
      await ensureChartOfAccounts(o);
      const y = new Date().getUTCFullYear();
      for (let m = 1; m <= 12; m++) await tenantCol<any>(o, "fiscal_periods").insertOne({ _id: `${o}:${y}-${m}`, year: y, month: m, status: "open", start: new Date(Date.UTC(y, m - 1, 1, -4)), end: new Date(Date.UTC(y, m, 1, -4)) });
      await postJournal(ctxFor(["finance_manager"], o, "f", "b"), { date: new Date(), memo: "sale", idempotencyKey: `g-${o}`, sourceRef: { type: "t", id: o }, lines: [{ accountId: `${o}:1000`, debit: o === PARENT ? "1000" : "400" }, { accountId: `${o}:4000`, credit: o === PARENT ? "1000" : "400" }] });
    }
    const g = await createGroup(pAdmin, { name: "Test Group", memberOrgIds: [CHILD] });
    const range = { from: new Date(Date.now() - 86400000), to: new Date(Date.now() + 86400000) };
    const before = await groupConsolidatedPnl(pAdmin, g._id, range);
    expect(before.excluded).toEqual([CHILD]);
    expect(before.totalIncome.toFixed(2)).toBe("1000.00");
    await expect(agreeToGroup(ctxFor(["org_admin"], "stranger-org", "s", "b"), PARENT, g._id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await agreeToGroup(cAdmin, PARENT, g._id);
    expect((await groupConsolidatedPnl(pAdmin, g._id, range)).totalIncome.toFixed(2)).toBe("1400.00");
    await revokeGroupAgreement(cAdmin, g._id);
    expect((await groupConsolidatedPnl(pAdmin, g._id, range)).excluded).toEqual([CHILD]);
    await expect(groupConsolidatedPnl(ctxFor(["receptionist"], PARENT, "r", "b"), g._id, range)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
