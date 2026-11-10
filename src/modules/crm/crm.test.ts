import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { ctxFor } from "@/test/helpers";
import { createPatient } from "@/modules/patients/service";
import { upsertTemplate, sendMessage, retryFailed, recordOptOut, deliveryStats, scheduleAppointmentReminders } from "@/modules/communications/service";
import {
  createEnquiry, convertEnquiry, createCampaign, buildRecallList, submitFeedback, satisfactionSummary, fileComplaint, progressComplaint, referralAnalysis,
  generateMissedAppointmentFollowUps, listDueFollowUps, listEnquiries,
} from "./service";

const ORG = "org-crm";
const reg = ctxFor(["receptionist"], ORG, "recep", "br1");
const mgr = ctxFor(["clinic_manager"], ORG, "mgr", "br1");
let consenting = "", optedOutOfMarketing = "", failing = "";

const base = { dob: "1990-01-01", sex: "female" as const };

beforeAll(async () => {
  await ensureIndexes();
  consenting = (await createPatient(reg, { ...base, fullName: "Consenting Carla", phone: "+971501110001", commPrefs: { sms: true, email: true, whatsapp: false, marketing: true }, allergies: [{ substance: "Latex" }], alerts: ["HIV positive (confidential)"] }))._id;
  optedOutOfMarketing = (await createPatient(reg, { ...base, fullName: "Private Pia", phone: "+971501110002", commPrefs: { sms: true, email: false, whatsapp: false, marketing: false } }))._id;
  failing = (await createPatient(reg, { ...base, fullName: "Failing Fay", phone: "+971500000000", commPrefs: { sms: true, email: false, whatsapp: false, marketing: false } }))._id;
  await tenantCol<any>(ORG, "staff").insertOne({ _id: "d1", userKey: "d1", name: "Dr Remind", role: "doctor", workDays: [1, 2, 3, 4, 5, 6, 0], workStart: "00:00", workEnd: "23:59", slotMinutes: 20, branchId: "br1", active: true });
});
afterAll(async () => { await closeClient(); });

describe("communications", () => {
  it("templates reject unknown placeholders, clinical wording on insecure channels, and marketing without opt-out text", async () => {
    await expect(upsertTemplate(reg, { key: "x", channel: "sms", language: "en", body: "Hi {{secret}}", category: "transactional" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(upsertTemplate(reg, { key: "x", channel: "sms", language: "en", body: "Your test result for {{patientName}} is ready", category: "transactional" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(upsertTemplate(reg, { key: "x", channel: "email", language: "en", body: "Your diagnosis letter is attached", category: "transactional" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(upsertTemplate(reg, { key: "promo", channel: "sms", language: "en", body: "Checkup offer for {{patientName}}", category: "marketing" })).rejects.toMatchObject({ code: "VALIDATION" });
    await upsertTemplate(reg, { key: "appointment_reminder", channel: "sms", language: "en", body: "Reminder: {{patientName}}, appointment {{appointmentTime}} with {{doctorName}} at {{clinicName}}.", category: "transactional" });
    await upsertTemplate(reg, { key: "promo", channel: "sms", language: "en", body: "Checkup offer for {{patientName}}. Reply STOP to opt out.", category: "marketing" });
    await upsertTemplate(reg, { key: "report_ready", channel: "in_app", language: "en", body: "Your results are available in the portal.", category: "transactional" });
  });

  it("respects channel consent, marketing consent and opt-out, and logs every outcome", async () => {
    expect((await sendMessage(reg, { patientId: consenting, templateKey: "promo", channel: "sms" })).status).toBe("sent");
    const noMkt = await sendMessage(reg, { patientId: optedOutOfMarketing, templateKey: "promo", channel: "sms" });
    expect(noMkt.status).toBe("skipped_consent");
    expect((await sendMessage(reg, { patientId: optedOutOfMarketing, templateKey: "appointment_reminder", channel: "sms", vars: { appointmentTime: "t", doctorName: "d", clinicName: "c" } })).status).toBe("sent");
    await recordOptOut(reg, consenting, "sms");
    expect((await sendMessage(reg, { patientId: consenting, templateKey: "promo", channel: "sms" })).status).toBe("skipped_optout");
    expect((await sendMessage(reg, { patientId: consenting, templateKey: "report_ready", channel: "in_app" })).status).toBe("sent");
  });

  it("failures are retried up to three attempts then dead-lettered", async () => {
    const d = await sendMessage(reg, { patientId: failing, templateKey: "appointment_reminder", channel: "sms" });
    expect(d.status).toBe("failed");
    expect((await retryFailed(reg)).retried).toBe(1);
    expect((await retryFailed(reg)).dead).toBe(1);
    expect((await retryFailed(reg)).retried).toBe(0);
    expect((await deliveryStats(reg)).dead).toBe(1);
  });

  it("appointment reminders are idempotent and never contain clinical detail", async () => {
    await tenantCol<any>(ORG, "appointments").insertOne({ _id: "ap-rem", patientId: optedOutOfMarketing, doctorId: "d1", branchId: "br1", status: "booked", start: new Date(Date.now() + 3 * 3600_000), end: new Date(Date.now() + 4 * 3600_000), type: "consultation", createdAt: new Date(), createdBy: "x", history: [] });
    const a = await scheduleAppointmentReminders(reg, { withinHours: 24 });
    const b = await scheduleAppointmentReminders(reg, { withinHours: 24 });
    expect(a.created).toBe(1);
    expect(b.created).toBe(0);
    const logged = await tenantCol<any>(ORG, "comm_deliveries").findOne({ dedupeKey: "reminder:ap-rem" });
    expect(logged.body).toContain("Dr Remind");
    expect(logged.body).not.toMatch(/diagnos|allerg|result/i);
  });
});

describe("CRM", () => {
  it("enquiry -> conversion registers the patient with the source as referral", async () => {
    const e = await createEnquiry(reg, { name: "Walk Wanda", phone: "+971501110009", channel: "phone", source: "instagram", interest: "dental check" });
    const { patientId } = await convertEnquiry(reg, e._id, { ...base, fullName: "Walk Wanda", phone: "+971501110009" });
    expect(patientId).toBeTruthy();
    await expect(convertEnquiry(reg, e._id, { ...base, fullName: "Walk Wanda", phone: "+971501110009" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await listEnquiries(reg))[0].status).toBe("converted");
    const ra = await referralAnalysis(mgr);
    expect(ra.find((r) => r.source === "instagram")).toMatchObject({ patients: 1, enquiries: 1, converted: 1, conversionPct: 100 });
  });

  it("recall list honours consent and exposes contact data only (no clinical fields)", async () => {
    for (const [id, pid, days] of [["old1", consenting, 400], ["old2", optedOutOfMarketing, 400]] as const)
      await tenantCol<any>(ORG, "appointments").insertOne({ _id: id, patientId: pid, doctorId: "d1", branchId: "br1", status: "completed", start: new Date(Date.now() - days * 86400000), end: new Date(Date.now() - days * 86400000), type: "consultation", createdAt: new Date(), createdBy: "x", history: [] });
    const recall = await createCampaign(mgr, { name: "Annual checkup recall", kind: "recall", channel: "sms", lastVisitBeforeDays: 365 });
    const r = await buildRecallList(mgr, recall._id);
    expect(r.candidates.map((c) => c.id).sort()).toEqual([consenting, optedOutOfMarketing].sort()); // care recall needs sms agreement only
    const mkt = await createCampaign(mgr, { name: "Dental offer", kind: "marketing", channel: "sms", lastVisitBeforeDays: 365 });
    const m = await buildRecallList(mgr, mkt._id);
    expect(m.candidates.map((c) => c.id)).toContain(consenting);
    expect(m.candidates.map((c) => c.id)).not.toContain(optedOutOfMarketing);
    expect(m.excludedNoConsent).toBeGreaterThan(0);
    const json = JSON.stringify(m.candidates);
    expect(json).not.toMatch(/Latex|HIV|allerg|alerts|diagnos/i);
    expect(Object.keys(m.candidates[0]).sort()).toEqual(["fullName", "id", "lastVisit", "phone", "preferredLanguage"]);
  });

  it("missed-appointment follow-ups are created once per no-show", async () => {
    await tenantCol<any>(ORG, "appointments").insertOne({ _id: "ns1", patientId: consenting, doctorId: "d1", branchId: "br1", status: "no_show", start: new Date(Date.now() - 2 * 86400000), end: new Date(Date.now() - 2 * 86400000 + 1200000), type: "consultation", createdAt: new Date(), createdBy: "x", history: [] });
    expect(await generateMissedAppointmentFollowUps(reg)).toBe(1);
    expect(await generateMissedAppointmentFollowUps(reg)).toBe(0);
    expect((await listDueFollowUps(reg)).some((f) => f.kind === "missed_appointment")).toBe(true);
  });

  it("feedback and NPS are computed; complaints need a resolution to close", async () => {
    for (const [r, n] of [[5, 10], [5, 9], [4, 8], [2, 3]] as const) await submitFeedback(reg, { rating: r, nps: n });
    await expect(submitFeedback(reg, { rating: 9 })).rejects.toMatchObject({ code: "VALIDATION" });
    const s = await satisfactionSummary(mgr);
    expect(s.avgRating).toBeCloseTo(4);
    expect(s.nps).toBeCloseTo(25); // 2 promoters, 1 detractor of 4
    const c = await fileComplaint(reg, { category: "waiting time", description: "Waited over an hour without update" });
    await progressComplaint(mgr, c._id, "investigating", { assignedTo: "mgr" });
    await expect(progressComplaint(mgr, c._id, "resolved")).rejects.toMatchObject({ code: "VALIDATION" });
    await progressComplaint(mgr, c._id, "resolved", { resolution: "Apologised; added queue notifications" });
    await expect(progressComplaint(mgr, c._id, "investigating")).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("org isolation", async () => {
    expect(await listEnquiries(ctxFor(["clinic_manager"], "other-org", "x"))).toHaveLength(0);
  });
});
