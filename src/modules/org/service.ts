import { z } from "zod";
import { tenantCol } from "@/core/db";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";

export const ModuleFlags = z.object({
  insurance: z.boolean().default(true), pharmacy: z.boolean().default(false), laboratory: z.boolean().default(false),
  inventory: z.boolean().default(false), hr: z.boolean().default(false),
  hospital: z.boolean().default(false), // inpatient/ER/theatre: off by default
});

export const OrgInput = z.object({
  name: z.string().min(2),
  facilityType: z.enum(["gp_clinic", "dental", "dermatology", "physio", "polyclinic", "diagnostic", "day_surgery", "specialty", "hospital"]),
  jurisdiction: z.enum(["DHA", "DOH", "MOHAP", "DHCC", "OTHER"]),
  currency: z.string().default("AED"),
  timezone: z.string().default("Asia/Dubai"),
  languages: z.array(z.enum(["en", "ar"])).default(["en", "ar"]),
  licenseNo: z.string().optional(),
  trn: z.string().optional(), // tax registration number
  modules: ModuleFlags.default(ModuleFlags.parse({})),
});
export type OrgInput = z.input<typeof OrgInput>;
export type OrgConfig = z.output<typeof OrgInput> & { _id: string; orgId: string; createdAt: Date };

export async function createOrg(input: OrgInput, id: string = newId()): Promise<OrgConfig> {
  const parsed = OrgInput.safeParse(input);
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.message);
  const doc = { ...parsed.data, _id: id, createdAt: new Date() };
  await tenantCol(id, "orgs").insertOne(doc as never);
  return { ...doc, orgId: id } as OrgConfig;
}

export async function getOrgConfig(orgId: string): Promise<OrgConfig> {
  const o = await tenantCol<OrgConfig>(orgId, "orgs").findOne({ _id: orgId } as never);
  if (!o) throw new AppError("NOT_FOUND", "Organization not found");
  return o;
}

export type Branch = { _id: string; code: string; name: string; emirate: string; address?: string; active: boolean };

export async function createBranch(orgId: string, input: { code: string; name: string; emirate: string; address?: string }): Promise<Branch> {
  const b: Branch = { _id: newId(), ...input, active: true };
  try {
    await tenantCol<Branch>(orgId, "branches").insertOne(b);
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw new AppError("CONFLICT", `Branch code ${input.code} exists`);
    throw e;
  }
  return b;
}
