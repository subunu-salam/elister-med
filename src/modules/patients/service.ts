import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { nextSeq } from "@/core/counters";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { encryptField, blindIndex } from "@/core/crypto";
import { PatientInput, type Patient } from "./schema";

const COL = "patients";
const maskEid = (eid: string) => { const d = eid.replace(/\D/g, ""); return `${d.slice(0, 3)}-****-*******-${d.slice(-1)}`; };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const normPhone = (p: string) => p.replace(/[^\d+]/g, "");

/** Strip secrets before returning to callers. */
function present(p: Patient & { emiratesIdEnc?: string; emiratesIdHash?: string }) {
  const { emiratesIdEnc: _e, emiratesIdHash: _h, ...rest } = p as Patient & Record<string, unknown>;
  void _e; void _h;
  return rest as Omit<Patient, "emiratesIdEnc" | "emiratesIdHash">;
}

export async function createPatient(ctx: Ctx, input: PatientInput) {
  assertPermission(ctx, "patients:create");
  const parsed = PatientInput.safeParse(input);
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.message);
  const d = parsed.data;
  const col = tenantCol<Patient>(ctx.orgId, COL);

  const eidHash = d.emiratesId ? blindIndex(d.emiratesId.replace(/\D/g, "")) : undefined;
  const dupFilters: object[] = [{ fullName: new RegExp(`^${esc(d.fullName)}$`, "i"), dob: d.dob }];
  if (eidHash) dupFilters.push({ emiratesIdHash: eidHash });
  const dups = await col.find({ $or: dupFilters } as never, { limit: 5 });

  return withTransaction(async (s) => {
    const seq = await nextSeq(ctx.orgId, "mrn", s);
    const { emiratesId, ...rest } = d;
    const doc: Patient & { duplicateOf?: string[] } = {
      _id: newId(), mrn: `MRN-${String(seq).padStart(6, "0")}`, ...rest, phone: normPhone(d.phone),
      ...(emiratesId ? { emiratesIdEnc: encryptField(emiratesId), emiratesIdHash: eidHash, emiratesIdMasked: maskEid(emiratesId) } : {}),
      createdAt: new Date(), createdBy: ctx.userId,
    };
    await col.insertOne(doc, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "patient.create", resource: "patient", resourceId: doc._id, after: { mrn: doc.mrn } });
    return { ...present(doc), duplicateOf: dups.map((x) => x._id) };
  });
}

export async function getPatient(ctx: Ctx, id: string) {
  assertPermission(ctx, "patients:view");
  const p = await tenantCol<Patient>(ctx.orgId, COL).findOne({ _id: id } as never);
  if (!p) throw new AppError("NOT_FOUND", "Patient not found");
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "patient.read", resource: "patient", resourceId: id }));
  return present(p);
}

export type PatientHit = { _id: string; mrn: string; fullName: string; fullNameAr?: string; dob: string; phone: string };

export async function searchPatients(ctx: Ctx, q: string): Promise<PatientHit[]> {
  assertPermission(ctx, "patients:view");
  const term = q.trim();
  if (term.length < 2) return [];
  const re = new RegExp(esc(term), "i");
  const phone = new RegExp(esc(normPhone(term)));
  const rows = await tenantCol<Patient>(ctx.orgId, COL).find(
    { $or: [{ fullName: re }, { fullNameAr: re }, { mrn: re }, ...(normPhone(term).length >= 3 ? [{ phone }] : [])] } as never,
    { limit: 20, sort: { createdAt: -1 } },
  );
  return rows.map((p) => ({ _id: p._id, mrn: p.mrn, fullName: p.fullName, fullNameAr: p.fullNameAr, dob: p.dob, phone: p.phone }));
}

/** Lightweight id -> name lookup for list screens (no clinical data, not audited per row). */
export async function patientNames(ctx: Ctx, ids: string[]): Promise<Map<string, { fullName: string; mrn: string }>> {
  assertPermission(ctx, "patients:view");
  const rows = await tenantCol<Patient>(ctx.orgId, COL).find({ _id: { $in: [...new Set(ids)] } } as never);
  return new Map(rows.map((p) => [p._id, { fullName: p.fullName, mrn: p.mrn }]));
}


export type ContactInfo = { id: string; fullName: string; phone: string; email?: string; preferredLanguage: string; referralSource?: string; commPrefs: Record<string, boolean>; createdAt: Date };

/** Contact-only projection for CRM and communications. Deliberately excludes every clinical field (allergies, alerts, identifiers). */
export async function contactInfo(ctx: Ctx, ids: string[]): Promise<Map<string, ContactInfo>> {
  if (!["crm:view", "communications:view", "patients:view"].some((p) => ctx.permissions.includes(p as never))) throw new AppError("FORBIDDEN", "Missing permission crm:view");
  const rows = await tenantCol<Patient>(ctx.orgId, COL).find({ _id: { $in: [...new Set(ids)] } } as never);
  return new Map(rows.map((p) => [p._id, { id: p._id, fullName: p.fullName, phone: p.phone, email: p.email, preferredLanguage: p.preferredLanguage, referralSource: p.referralSource, commPrefs: p.commPrefs, createdAt: p.createdAt }]));
}
export async function listContactIds(ctx: Ctx, limit = 5000): Promise<string[]> {
  if (!["crm:view", "communications:view", "patients:view"].some((p) => ctx.permissions.includes(p as never))) throw new AppError("FORBIDDEN", "Missing permission crm:view");
  return (await tenantCol<Patient>(ctx.orgId, COL).find({} as never, { limit })).map((p) => p._id);
}
