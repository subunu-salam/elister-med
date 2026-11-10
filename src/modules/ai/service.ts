import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { fromDecimal128 } from "@/core/money";
import { dubaiParts } from "@/core/time";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { assertSlotFree } from "@/modules/appointments/availability";
import { bookAppointment, listAppointments, listDoctors } from "@/modules/appointments/service";
import { executiveDashboard } from "@/modules/dashboard/executive";
import { denialAnalysis } from "@/modules/insurance/claims";
import { getWorkspace, saveDraftNote } from "@/modules/emr/service";
import { listPatientEncounters } from "@/modules/emr/service";
import { getPatient } from "@/modules/patients/service";
import type { Appointment } from "@/modules/appointments/schema";

/**
 * Every assistant here runs on deterministic local rules. There is NO external AI provider, no model call and no identifiable data leaves
 * the system. Anything clinical is a DRAFT that a clinician must review; assistants cannot diagnose, prescribe, sign, authorise or decide.
 */
export const AI_PROVIDER = { name: "local-rules", mode: "local" as const };

/** External providers need documented lawful basis, data-residency verification and contracts. None is installed, so this always refuses. */
export async function assertExternalProviderAllowed(ctx: Ctx): Promise<never> {
  assertPermission(ctx, "ai:create");
  const g = await tenantCol<{ externalApprovedBy?: string; dpaRef?: string; residencyVerified?: boolean }>(ctx.orgId, "ai_governance").findOne({ key: "main" } as never);
  if (!g?.externalApprovedBy || !g.dpaRef || !g.residencyVerified) throw new AppError("CONFLICT", "External AI is blocked: lawful processing, data residency and contractual approvals have not been recorded");
  throw new AppError("CONFLICT", "No external AI adapter is installed in this build");
}

const logCall = (ctx: Ctx, tool: string, after: unknown) => withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: `ai.${tool}`, resource: "ai", resourceId: tool, after }));
const CLINICAL_Q = /symptom|diagnos|medicat|dose|dosage|pain|treat|prescri|rash|fever|ألم|دواء|تشخيص|جرعة/i;

// ================= Front-office assistant =================
export type OrgSettings = { openingHours?: string; address?: string; phone?: string };
export async function setOrgSettings(ctx: Ctx, s0: OrgSettings) {
  assertPermission(ctx, "org:update");
  await tenantCol(ctx.orgId, "org_settings").updateOne({ key: "main" } as never, { $set: s0 } as never, undefined, { upsert: true });
}

/** Answers facility questions from configured data only, in English or Arabic. Declines clinical questions. Says so when information is not configured. */
export async function answerFacilityQuestion(ctx: Ctx, question: string, lang: "en" | "ar" = "en"): Promise<{ answer: string; aiGenerated: true; handled: boolean }> {
  assertPermission(ctx, "ai:view");
  const q = question.toLowerCase();
  const ar = lang === "ar";
  const T = (en: string, a: string) => (ar ? a : en);
  const set: OrgSettings = (await tenantCol<OrgSettings>(ctx.orgId, "org_settings").findOne({ key: "main" } as never)) ?? {};
  let answer: string, handled = true;
  if (CLINICAL_Q.test(question)) {
    answer = T("I can't give medical advice or discuss symptoms or medicines. Please book an appointment with a doctor, or call us.", "لا يمكنني تقديم نصائح طبية أو مناقشة الأعراض أو الأدوية. يرجى حجز موعد مع الطبيب أو الاتصال بنا.");
    handled = false;
  } else if (/hour|open|close|ساعات|دوام/.test(q)) answer = set.openingHours ? T(`Opening hours: ${set.openingHours}`, `ساعات العمل: ${set.openingHours}`) : T("Opening hours have not been configured yet. Please call reception.", "لم يتم ضبط ساعات العمل بعد. يرجى الاتصال بالاستقبال.");
  else if (/doctor|specialist|طبيب|أطباء/.test(q)) { const d = await listDoctors(ctx); answer = d.length ? T(`Our doctors: ${d.map((x) => `${x.name}${x.specialty ? ` (${x.specialty})` : ""}`).join(", ")}`, `أطباؤنا: ${d.map((x) => x.nameAr ?? x.name).join("، ")}`) : T("No doctors are listed yet.", "لا يوجد أطباء مدرجون بعد."); }
  else if (/price|cost|fee|how much|سعر|تكلفة|رسوم/.test(q)) {
    const svc = await tenantCol<{ name: string; price: unknown; taxCode: string }>(ctx.orgId, "services").find({ active: true } as never, { limit: 20 });
    answer = svc.length ? T(`Indicative fees (before VAT): ${svc.map((s) => `${s.name} AED ${fromDecimal128(s.price as never).toFixed(2)}`).join("; ")}`, `الرسوم التقريبية (قبل الضريبة): ${svc.map((s) => `${s.name} ${fromDecimal128(s.price as never).toFixed(2)} د.إ`).join("؛ ")}`) : T("Fees are not listed yet.", "الرسوم غير مدرجة بعد.");
  } else if (/where|address|location|عنوان|موقع/.test(q)) answer = set.address ? T(`We are at: ${set.address}`, `عنواننا: ${set.address}`) : T("The address has not been configured yet.", "لم يتم ضبط العنوان بعد.");
  else if (/book|appointment|slot|موعد|حجز/.test(q)) answer = T("I can look up available times for a doctor on a given day and book one for you.", "يمكنني البحث عن المواعيد المتاحة لطبيب في يوم معين وحجز موعد لك.");
  else { answer = T("I'm not sure about that. Please contact reception for help.", "لست متأكدًا من ذلك. يرجى التواصل مع الاستقبال للمساعدة."); handled = false; }
  await logCall(ctx, "faq", { handled });
  return { answer, aiGenerated: true, handled };
}

/** Free times for a doctor on a Dubai date, using the same availability rules as real booking (hours, leave, holidays, existing bookings). */
export async function findAvailableSlots(ctx: Ctx, input: { doctorId: string; date: string; durationMin?: number }): Promise<string[]> {
  assertPermission(ctx, "ai:view");
  const doc = (await listDoctors(ctx)).find((d) => d._id === input.doctorId);
  if (!doc) throw new AppError("NOT_FOUND", "Doctor not found");
  const dur = (input.durationMin ?? doc.slotMinutes) * 60000;
  const [sh, sm] = doc.workStart.split(":").map(Number), [eh, em] = doc.workEnd.split(":").map(Number);
  const dayStart = new Date(`${input.date}T00:00:00+04:00`).getTime();
  const out: string[] = [];
  for (let t = dayStart + (sh * 60 + sm) * 60000; t + dur <= dayStart + (eh * 60 + em) * 60000; t += doc.slotMinutes * 60000) {
    try { await assertSlotFree(ctx.orgId, input.doctorId, new Date(t), new Date(t + dur)); out.push(new Date(t).toISOString()); } catch { /* not free */ }
  }
  await logCall(ctx, "slots", { doctorId: input.doctorId, date: input.date, found: out.length });
  return out;
}
/** Booking goes through the normal service with the caller's own permissions: the assistant cannot do anything the person could not. */
export async function assistantBook(ctx: Ctx, input: { patientId: string; doctorId: string; start: Date; durationMin: number }): Promise<Appointment> {
  assertPermission(ctx, "ai:view");
  const a = await bookAppointment(ctx, { patientId: input.patientId, doctorId: input.doctorId, start: input.start, end: new Date(input.start.getTime() + input.durationMin * 60000), type: "consultation", notes: "Booked via assistant" });
  await logCall(ctx, "book", { appointmentId: a._id });
  return a;
}

// ================= Operational assistant =================
export async function revenueTrendSummary(ctx: Ctx, f: { from: Date; to: Date }) {
  assertPermission(ctx, "ai:view");
  const r = await executiveDashboard(ctx, f);
  const c = r.current, d = r.delta;
  const dir = (p: number | null) => (p === null ? "no prior-period figure" : `${p >= 0 ? "up" : "down"} ${Math.abs(p).toFixed(1)}%`);
  const lines = [`Revenue AED ${c.revenue}, ${dir(d.revenue.pct)} versus the previous period.`, `${c.appointments} appointments (${dir(d.appointments.pct)}); no-show rate ${(c.noShowRate * 100).toFixed(1)}%.`, `Outstanding receivables AED ${c.outstandingReceivables}.`];
  const top = c.revenueByDoctor[0];
  if (top) lines.push(`Largest revenue contribution: ${top.key} (AED ${top.amount}).`);
  await logCall(ctx, "revenue_summary", {});
  return { text: lines.join(" "), basis: "Computed from ledger and appointment data; no model involved.", aiGenerated: true as const };
}

/** Moving average of appointments per weekday over the last N weeks. */
export async function demandForecast(ctx: Ctx, weeks = 8) {
  assertPermission(ctx, "ai:view");
  const appts = await listAppointments(ctx, { from: new Date(Date.now() - weeks * 7 * 86400000), to: new Date() });
  const by = new Array(7).fill(0);
  for (const a of appts) if (a.status !== "cancelled") by[dubaiParts(a.start).dow]++;
  return { weekdayAverage: by.map((n, dow) => ({ dow, expected: Math.round((n / weeks) * 10) / 10 })), basis: `Average of the last ${weeks} weeks. A baseline, not a validated forecasting model.` };
}

/** Transparent heuristic. Weights are illustrative and have NOT been validated against outcomes; use only to prioritise reminder calls. */
export async function noShowRisk(ctx: Ctx, appointmentId: string) {
  assertPermission(ctx, "ai:view");
  const a = (await listAppointments(ctx, { from: new Date(0), to: new Date(Date.now() + 365 * 86400000) })).find((x) => x._id === appointmentId);
  if (!a) throw new AppError("NOT_FOUND", "Appointment not found");
  const past = (await listAppointments(ctx, { from: new Date(0), to: new Date() })).filter((x) => x.patientId === a.patientId && x._id !== a._id && ["completed", "no_show"].includes(x.status));
  const prior = past.length ? past.filter((x) => x.status === "no_show").length / past.length : 0;
  const leadDays = (a.start.getTime() - a.createdAt.getTime()) / 86400000;
  const reasons: string[] = [];
  let score = 0.1;
  if (prior > 0) { score += Math.min(0.6, prior * 0.6); reasons.push(`${Math.round(prior * 100)}% of earlier visits were no-shows`); }
  if (leadDays > 14) { score += 0.15; reasons.push("booked more than 14 days ahead"); }
  const dow = dubaiParts(a.start).dow;
  if (dow === 1 || dow === 5) { score += 0.05; reasons.push("Monday/Friday slot"); }
  return { score: Math.min(0.95, Math.round(score * 100) / 100), reasons, validated: false as const, note: "Heuristic for prioritising reminders; not clinically or statistically validated." };
}

/** Average daily dispensed quantity x lead time + safety days. */
export async function inventoryDemand(ctx: Ctx, input: { itemId: string; days?: number; leadTimeDays: number; safetyDays?: number }) {
  assertPermission(ctx, "ai:view");
  const days = input.days ?? 30;
  const mv = await tenantCol<{ qty: number; type: string }>(ctx.orgId, "inv_movements").find({ itemId: input.itemId, type: "dispense", at: { $gte: new Date(Date.now() - days * 86400000) } } as never, { limit: 100000 });
  const used = mv.reduce((a, m) => a - m.qty, 0);
  const daily = used / days;
  return { dailyUse: Math.round(daily * 100) / 100, suggestedReorderPoint: Math.ceil(daily * (input.leadTimeDays + (input.safetyDays ?? 3))), basis: `Average over the last ${days} days.` };
}

/** Days whose income deviates more than 3 standard deviations from the period mean. Needs at least 14 days of data. */
export async function revenueAnomalies(ctx: Ctx, f: { from: Date; to: Date }) {
  assertPermission(ctx, "ai:view");
  const rows = await tenantCol<{ date: Date; credit: unknown; debit: unknown }>(ctx.orgId, "gl_lines").find({ accountType: "income", date: { $gte: f.from, $lt: f.to } } as never, { limit: 200000 });
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(dubaiParts(r.date).ymd, (byDay.get(dubaiParts(r.date).ymd) ?? 0) + Number(fromDecimal128(r.credit as never)) - Number(fromDecimal128(r.debit as never)));
  const vals = [...byDay.values()];
  if (vals.length < 14) return { anomalies: [], note: "Not enough days of data (need 14)." };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length, sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  return { anomalies: [...byDay].filter(([, v]) => sd > 0 && Math.abs(v - mean) / sd > 3).map(([day, v]) => ({ day, amount: Math.round(v * 100) / 100, zScore: Math.round(((v - mean) / sd) * 10) / 10 })), note: "Statistical outliers only; investigate before concluding anything." };
}
export async function claimsDenialInsights(ctx: Ctx) {
  assertPermission(ctx, "ai:view");
  const d = await denialAnalysis(ctx);
  return { top: d.slice(0, 5), summary: d.length ? `${d[0].reason} is the most frequent denial reason (${d[0].count}).` : "No denials recorded.", aiGenerated: true as const };
}

// ================= Clinical documentation assistant (drafts only) =================
export type AiDraft = { _id: string; encounterId: string; kind: "soap"; content: { s: string; o: string; a: string; p: string }; status: "draft" | "accepted" | "rejected"; aiGenerated: true; source: string; createdBy: string; at: Date; reviewedBy?: string };
const drafts = (o: string) => tenantCol<AiDraft>(o, "ai_drafts");

/** Splits dictation into SOAP using cue words. Content is the clinician's own words, reformatted; nothing is added or inferred. Stays DRAFT until reviewed. */
export async function dictationToDraft(ctx: Ctx, input: { encounterId: string; text: string }): Promise<AiDraft> {
  assertPermission(ctx, "ai:create");
  assertPermission(ctx, "emr:update");
  if (input.text.trim().length < 10) throw new AppError("VALIDATION", "Dictation is too short");
  await getWorkspace(ctx, input.encounterId); // authorises access to this encounter and audits the read
  const cues: Record<"s" | "o" | "a" | "p", RegExp> = { s: /(complains? of|presents? with|history of|reports?)/i, o: /(on examination|examination|exam shows|vitals?|o\/e)/i, a: /(assessment|impression|diagnosis|likely)/i, p: /(plan|advised|prescribe|follow[- ]?up|review in)/i };
  const sentences = input.text.split(/(?<=[.!?])\s+/);
  const out = { s: [] as string[], o: [] as string[], a: [] as string[], p: [] as string[] };
  let cur: keyof typeof out = "s";
  for (const sen of sentences) { for (const k of ["p", "a", "o", "s"] as const) if (cues[k].test(sen)) { cur = k; break; } out[cur].push(sen.trim()); }
  const d: AiDraft = { _id: newId(), encounterId: input.encounterId, kind: "soap", content: { s: out.s.join(" "), o: out.o.join(" "), a: out.a.join(" "), p: out.p.join(" ") }, status: "draft", aiGenerated: true, source: AI_PROVIDER.name, createdBy: ctx.userId, at: new Date() };
  await withTransaction(async (s) => { await drafts(ctx.orgId).insertOne(d, s); await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "ai.draft_note", resource: "encounter", resourceId: input.encounterId, after: { draftId: d._id } }); });
  return d;
}
/** The clinician accepts a draft into the (still unsigned) note. Signing remains a separate, human action. */
export async function acceptDraft(ctx: Ctx, draftId: string) {
  assertPermission(ctx, "emr:update");
  const d = await drafts(ctx.orgId).findOne({ _id: draftId } as never);
  if (!d) throw new AppError("NOT_FOUND", "Draft not found");
  if (d.status !== "draft") throw new AppError("CONFLICT", `Draft is ${d.status}`);
  const w = await getWorkspace(ctx, d.encounterId);
  if (!w.note || w.note.status !== "draft") throw new AppError("CONFLICT", "The note is already signed; amend it instead of importing a draft");
  await saveDraftNote(ctx, w.note._id, d.content);
  await drafts(ctx.orgId).updateOne({ _id: draftId } as never, { $set: { status: "accepted", reviewedBy: ctx.userId } } as never);
  await logCall(ctx, "draft_accepted", { draftId });
}
export async function rejectDraft(ctx: Ctx, draftId: string) {
  assertPermission(ctx, "emr:update");
  const r = await drafts(ctx.orgId).updateOne({ _id: draftId, status: "draft" } as never, { $set: { status: "rejected", reviewedBy: ctx.userId } } as never);
  if (r.matchedCount === 0) throw new AppError("CONFLICT", "Draft not found or already reviewed");
}
export async function listDrafts(ctx: Ctx, encounterId: string) { assertPermission(ctx, "emr:view"); return drafts(ctx.orgId).find({ encounterId } as never, { sort: { at: -1 } }); }

export async function missingDocumentation(ctx: Ctx, encounterId: string): Promise<string[]> {
  assertPermission(ctx, "ai:view");
  const w = await getWorkspace(ctx, encounterId);
  const gaps: string[] = [];
  if (!w.encounter.diagnoses.length) gaps.push("No diagnosis recorded");
  if (!w.encounter.vitals.length) gaps.push("No vital signs recorded");
  for (const [k, label] of [["s", "Subjective"], ["o", "Objective"], ["a", "Assessment"], ["p", "Plan"]] as const) if (!w.note?.soap[k]?.trim()) gaps.push(`${label} section is empty`);
  if (w.note?.status === "draft") gaps.push("Note is not signed");
  return gaps;
}
/** Plain facts from records the caller is already authorised to read. Not a clinical interpretation. */
export async function summarizeRecord(ctx: Ctx, patientId: string) {
  assertPermission(ctx, "ai:view");
  assertPermission(ctx, "emr:view");
  const p = await getPatient(ctx, patientId);
  const encs = await listPatientEncounters(ctx, patientId);
  const dx = [...new Set(encs.flatMap((e) => e.diagnoses.map((d) => `${d.code} ${d.description}`)))];
  return { aiGenerated: true as const, status: "draft" as const, text: [`${p.fullName}, born ${p.dob}.`, p.allergies.length ? `Recorded allergies: ${p.allergies.map((a) => a.substance).join(", ")}.` : "No allergies recorded.", `${encs.length} encounter(s)${encs[0] ? `, most recent ${encs[0].openedAt.toISOString().slice(0, 10)}` : ""}.`, dx.length ? `Diagnoses on record: ${dx.join("; ")}.` : "No diagnoses on record."].join(" "), note: "Summary of existing records; clinician review required." };
}
