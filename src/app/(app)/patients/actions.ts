"use server";
import { run, requireCtx } from "@/lib/session";
import { createPatient } from "@/modules/patients/service";

const opt = (v: FormDataEntryValue | null) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export async function createPatientAction(fd: FormData) {
  const ctx = await requireCtx();
  await run("/patients/new", async () => {
    const allergyName = opt(fd.get("allergy"));
    const p = await createPatient(ctx, {
      fullName: String(fd.get("fullName") ?? ""),
      fullNameAr: opt(fd.get("fullNameAr")),
      dob: String(fd.get("dob") ?? ""),
      sex: (opt(fd.get("sex")) as "male" | "female" | "other" | "unknown") ?? "unknown",
      nationality: opt(fd.get("nationality")),
      phone: String(fd.get("phone") ?? ""),
      email: opt(fd.get("email")),
      address: opt(fd.get("address")),
      emiratesId: opt(fd.get("emiratesId")),
      emergencyContact: opt(fd.get("ecName")) ? { name: String(fd.get("ecName")), phone: String(fd.get("ecPhone") ?? ""), relation: opt(fd.get("ecRelation")) } : undefined,
      allergies: allergyName ? [{ substance: allergyName, reaction: opt(fd.get("allergyReaction")), severity: (opt(fd.get("allergySeverity")) as "mild" | "moderate" | "severe") }] : [],
      preferredLanguage: opt(fd.get("preferredLanguage")) === "ar" ? "ar" : "en",
      commPrefs: { sms: fd.get("sms") === "on", email: fd.get("emailPref") === "on", whatsapp: fd.get("whatsapp") === "on", marketing: fd.get("marketing") === "on" },
      consents: fd.get("consentTreatment") === "on" ? [{ type: "treatment", granted: true, at: new Date() }] : [],
    });
    const dup = p.duplicateOf.length ? `?dup=${p.duplicateOf.length}` : "";
    return `/patients/${p._id}${dup}`;
  });
}
