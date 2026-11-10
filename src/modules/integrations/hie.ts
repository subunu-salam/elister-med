import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { getPatient, searchPatients } from "@/modules/patients/service";

export type HieName = "NABIDH" | "MALAFFI" | "RIAYATI";
export type MessageType = "ADT_A04" | "FHIR_PATIENT";

export type DemographicPayload = { mrn: string; fullName: string; dob: string; sex: string; phone?: string; nationality?: string };

/** Required demographics for any outbound registration message. */
export function validateDemographics(p: Partial<DemographicPayload>): string[] {
  const e: string[] = [];
  if (!p.mrn) e.push("PID-3: patient identifier (MRN) missing");
  if (!p.fullName || p.fullName.trim().split(/\s+/).length < 2) e.push("PID-5: full name needs at least two parts");
  if (!p.dob || !/^\d{4}-\d{2}-\d{2}$/.test(p.dob)) e.push("PID-7: date of birth missing or malformed");
  if (!["male", "female", "other", "unknown"].includes(p.sex ?? "")) e.push("PID-8: administrative sex missing");
  return e;
}

const hl7 = (s: string) => s.replace(/[|^~\\&\r\n]/g, " ");
const hl7Date = (d: string) => d.replaceAll("-", "");
const SEX: Record<string, string> = { male: "M", female: "F", other: "O", unknown: "U" };

/** HL7 v2.5 ADT^A04 (register a patient). Segment separator is CR as required by HL7. Facility/application identifiers come from organisation configuration. */
export function buildAdtA04(p: DemographicPayload, ctx: { sendingFacility: string; receivingFacility: string; controlId: string; at?: Date }): string {
  const ts = (ctx.at ?? new Date()).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const [family, ...given] = p.fullName.trim().split(/\s+/).reverse();
  const segs = [
    `MSH|^~\\&|HEALTHOS|${hl7(ctx.sendingFacility)}|HIE|${hl7(ctx.receivingFacility)}|${ts}||ADT^A04^ADT_A01|${ctx.controlId}|P|2.5`,
    `EVN|A04|${ts}`,
    `PID|1||${hl7(p.mrn)}^^^HEALTHOS^MR||${hl7(family)}^${hl7(given.reverse().join(" "))}||${hl7Date(p.dob)}|${SEX[p.sex] ?? "U"}|||||${hl7(p.phone ?? "")}`,
    `PV1|1|O`,
  ];
  return segs.join("\r");
}

/** FHIR R4 Patient resource (administrative demographics only). */
export function buildFhirPatient(p: DemographicPayload) {
  const parts = p.fullName.trim().split(/\s+/);
  return {
    resourceType: "Patient",
    identifier: [{ system: "urn:healthos:mrn", value: p.mrn }],
    name: [{ use: "official", family: parts[parts.length - 1], given: parts.slice(0, -1), text: p.fullName }],
    gender: p.sex === "male" || p.sex === "female" || p.sex === "other" ? p.sex : "unknown",
    birthDate: p.dob,
    ...(p.phone ? { telecom: [{ system: "phone", value: p.phone }] } : {}),
  };
}

// ---------- Code mapping ----------
export async function setCodeMap(ctx: Ctx, input: { system: string; localCode: string; standardCode: string; standardSystem: string }) {
  assertPermission(ctx, "integrations:update");
  await tenantCol(ctx.orgId, "code_maps").updateOne({ system: input.system, localCode: input.localCode } as never, { $set: input, $setOnInsert: { _id: newId() } } as never, undefined, { upsert: true });
}
export async function mapCode(ctx: Ctx, system: string, localCode: string): Promise<{ standardCode: string; standardSystem: string } | null> {
  assertPermission(ctx, "integrations:view");
  const m = await tenantCol<{ standardCode: string; standardSystem: string }>(ctx.orgId, "code_maps").findOne({ system, localCode } as never);
  return m ? { standardCode: m.standardCode, standardSystem: m.standardSystem } : null;
}

// ---------- Patient identity matching ----------
/** Transparent scoring for linking an incoming identity to local patients. Exact identifier or name+DOB agreement; anything else is a weak candidate for manual review. */
export async function matchPatient(ctx: Ctx, cand: { fullName: string; dob: string; phone?: string }) {
  assertPermission(ctx, "integrations:view");
  const hits = await searchPatients(ctx, cand.fullName.split(/\s+/)[0]);
  return hits.map((h) => {
    let score = 0; const why: string[] = [];
    if (h.fullName.toLowerCase() === cand.fullName.toLowerCase()) { score += 50; why.push("exact name"); }
    else if (h.fullName.toLowerCase().includes(cand.fullName.split(/\s+/).slice(-1)[0].toLowerCase())) { score += 20; why.push("family name"); }
    if (h.dob === cand.dob) { score += 40; why.push("date of birth"); }
    if (cand.phone && h.phone.endsWith(cand.phone.replace(/\D/g, "").slice(-8))) { score += 10; why.push("phone"); }
    return { patientId: h._id, mrn: h.mrn, score, why, decision: score >= 90 ? "match" : score >= 60 ? "review" : "no_match" } as const;
  }).filter((m) => m.score > 0).sort((a, b) => b.score - a.score);
}

// ---------- Transport boundary ----------
export type Ack = { code: "AA" | "AE" | "AR"; controlId: string; text?: string };
/** NABIDH, Malaffi and Riayati each need regulator onboarding, credentials and conformance testing: NONE of that exists here. Only a sandbox adapter, which transmits nothing. */
export type HieAdapter = { hie: HieName; mode: "sandbox" | "production"; send(raw: string, controlId: string): Promise<Ack> };
export const sandboxHie = (hie: HieName): HieAdapter => ({
  hie, mode: "sandbox",
  async send(raw, controlId) {
    if (/REJECT/i.test(raw)) return { code: "AR", controlId, text: "Sandbox rejection (simulated)" };
    return { code: "AA", controlId, text: "Sandbox accepted (nothing was transmitted)" };
  },
});

export type HieMessage = {
  _id: string; hie: HieName; type: MessageType; patientId: string; controlId: string; payload: string; status: "pending" | "acknowledged" | "failed" | "dead";
  attempts: number; mode: "sandbox" | "production"; ack?: Ack; error?: string; createdAt: Date; lastAttemptAt?: Date;
};
const msgs = (o: string) => tenantCol<HieMessage>(o, "hie_messages");
const log = (ctx: Ctx, s: Parameters<typeof audit>[0], action: string, id: string, after: unknown) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action, resource: "hie_message", resourceId: id, after });

export async function enqueueHieMessage(ctx: Ctx, input: { hie: HieName; patientId: string; type: MessageType }): Promise<HieMessage> {
  assertPermission(ctx, "integrations:create");
  z.object({ hie: z.enum(["NABIDH", "MALAFFI", "RIAYATI"]), type: z.enum(["ADT_A04", "FHIR_PATIENT"]) }).parse(input);
  const p = await getPatient(ctx, input.patientId);
  const demo: DemographicPayload = { mrn: p.mrn, fullName: p.fullName, dob: p.dob, sex: p.sex, phone: p.phone, nationality: p.nationality };
  const errs = validateDemographics(demo);
  if (errs.length) throw new AppError("VALIDATION", `Message validation failed: ${errs.join("; ")}`);
  const org = await tenantCol<{ name: string }>(ctx.orgId, "orgs").findOne({ _id: ctx.orgId } as never);
  const controlId = newId().slice(-10);
  const payload = input.type === "ADT_A04" ? buildAdtA04(demo, { sendingFacility: org?.name ?? "FACILITY", receivingFacility: input.hie, controlId }) : JSON.stringify(buildFhirPatient(demo));
  const m: HieMessage = { _id: newId(), hie: input.hie, type: input.type, patientId: input.patientId, controlId, payload, status: "pending", attempts: 0, mode: "sandbox", createdAt: new Date() };
  await withTransaction(async (s) => { await msgs(ctx.orgId).insertOne(m, s); await log(ctx, s, "hie.enqueue", m._id, { hie: m.hie, type: m.type }); });
  return m;
}

/** Sends pending/failed messages. Retries up to 3 attempts, then moves to the error queue (status "dead"). Every attempt is audited. */
export async function processHieQueue(ctx: Ctx, adapters: Partial<Record<HieName, HieAdapter>> = {}) {
  assertPermission(ctx, "integrations:update");
  const out = { acknowledged: 0, failed: 0, dead: 0 };
  for (const m of await msgs(ctx.orgId).find({ status: { $in: ["pending", "failed"] } } as never, { sort: { createdAt: 1 }, limit: 200 })) {
    const adapter = adapters[m.hie] ?? sandboxHie(m.hie);
    let ack: Ack | undefined, error: string | undefined;
    try { ack = await adapter.send(m.payload, m.controlId); } catch (e) { error = String((e as Error).message); }
    const attempts = m.attempts + 1;
    const ok = ack?.code === "AA";
    const status = ok ? "acknowledged" : attempts >= 3 ? "dead" : "failed";
    await withTransaction(async (s) => {
      await msgs(ctx.orgId).updateOne({ _id: m._id } as never, { $set: { status, attempts, ack, error: error ?? (ok ? undefined : ack?.text), lastAttemptAt: new Date(), mode: adapter.mode } } as never, s);
      await log(ctx, s, `hie.${status}`, m._id, { attempts, ack: ack?.code, error });
    });
    out[ok ? "acknowledged" : status === "dead" ? "dead" : "failed"]++;
  }
  return out;
}

export async function interfaceMonitor(ctx: Ctx) {
  assertPermission(ctx, "integrations:view");
  const all = await msgs(ctx.orgId).find({} as never, { limit: 100000 });
  const by = (s: string) => all.filter((m) => m.status === s).length;
  return { total: all.length, pending: by("pending"), acknowledged: by("acknowledged"), failed: by("failed"), errorQueue: by("dead"), mode: "sandbox" as const };
}
export async function listErrorQueue(ctx: Ctx) { assertPermission(ctx, "integrations:view"); return msgs(ctx.orgId).find({ status: "dead" } as never, { sort: { createdAt: -1 }, limit: 100 }); }
export async function retryDead(ctx: Ctx, id: string) {
  assertPermission(ctx, "integrations:update");
  const r = await msgs(ctx.orgId).updateOne({ _id: id, status: "dead" } as never, { $set: { status: "pending", attempts: 0 } } as never);
  if (r.matchedCount === 0) throw new AppError("CONFLICT", "Message is not in the error queue");
}
export async function listHieMessages(ctx: Ctx) { assertPermission(ctx, "integrations:view"); return msgs(ctx.orgId).find({} as never, { sort: { createdAt: -1 }, limit: 100 }); }
