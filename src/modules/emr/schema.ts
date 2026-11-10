import { z } from "zod";

export const Soap = z.object({ s: z.string(), o: z.string(), a: z.string(), p: z.string() });
export type Soap = z.infer<typeof Soap>;

export const VitalsInput = z
  .object({
    systolic: z.number().min(40).max(300),
    diastolic: z.number().min(20).max(200),
    heartRate: z.number().min(20).max(250),
    respRate: z.number().min(4).max(80),
    tempC: z.number().min(30).max(45),
    spo2: z.number().min(50).max(100),
    weightKg: z.number().min(0.3).max(400),
    heightCm: z.number().min(20).max(260),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "At least one measurement required");
export type VitalsInput = z.infer<typeof VitalsInput>;

export const DiagnosisInput = z.object({
  code: z.string().min(2),
  system: z.string().default("ICD-10-CM"),
  description: z.string().min(2),
  primary: z.boolean().default(false),
});
export type DiagnosisInput = z.input<typeof DiagnosisInput>;

export type Encounter = {
  _id: string;
  appointmentId: string;
  patientId: string;
  doctorId: string;
  branchId: string;
  status: "open" | "completed";
  openedAt: Date;
  openedBy: string;
  completedAt?: Date;
  chiefComplaint?: string;
  vitals: (VitalsInput & { at: Date; by: string })[];
  diagnoses: (z.output<typeof DiagnosisInput> & { at: Date; by: string })[];
};

export type Note = {
  _id: string;
  encounterId: string;
  patientId: string;
  version: number;
  supersedes?: string;
  status: "draft" | "signed" | "superseded";
  soap: Soap;
  authorId: string;
  signedAt?: Date;
  signedBy?: string;
  amendReason?: string;
  createdAt: Date;
};
