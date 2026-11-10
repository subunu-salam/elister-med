import { z } from "zod";

export const EMIRATES_ID = /^784-?\d{4}-?\d{7}-?\d$/;

export const PatientInput = z.object({
  fullName: z.string().trim().min(2),
  fullNameAr: z.string().trim().optional(),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sex: z.enum(["male", "female", "other", "unknown"]),
  nationality: z.string().optional(),
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/),
  email: z.string().email().optional(),
  address: z.string().optional(),
  emiratesId: z.string().regex(EMIRATES_ID).optional(),
  passportNo: z.string().optional(),
  emergencyContact: z.object({ name: z.string(), phone: z.string(), relation: z.string().optional() }).optional(),
  guardianPatientId: z.string().optional(),
  allergies: z.array(z.object({ substance: z.string(), reaction: z.string().optional(), severity: z.enum(["mild", "moderate", "severe"]).optional() })).default([]),
  alerts: z.array(z.string()).default([]),
  referralSource: z.string().optional(),
  preferredLanguage: z.enum(["en", "ar"]).default("en"),
  commPrefs: z.object({ sms: z.boolean(), email: z.boolean(), whatsapp: z.boolean(), marketing: z.boolean() })
    .default({ sms: true, email: true, whatsapp: false, marketing: false }),
  consents: z.array(z.object({ type: z.string(), granted: z.boolean(), at: z.coerce.date() })).default([]),
});
export type PatientInput = z.input<typeof PatientInput>;

export type Patient = {
  _id: string; mrn: string; fullName: string; fullNameAr?: string; dob: string; sex: string;
  nationality?: string; phone: string; email?: string; address?: string;
  emiratesIdEnc?: string; emiratesIdHash?: string; emiratesIdMasked?: string; passportNo?: string;
  emergencyContact?: unknown; guardianPatientId?: string;
  allergies: { substance: string; reaction?: string; severity?: string }[]; alerts: string[];
  referralSource?: string; preferredLanguage: string; commPrefs: Record<string, boolean>; consents: unknown[];
  createdAt: Date; createdBy: string;
};
