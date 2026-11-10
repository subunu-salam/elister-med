"use server";
import { run, requireCtx } from "@/lib/session";
import { addDiagnosis, amendNote, completeEncounter, recordVitals, saveDraftNote, signNote } from "@/modules/emr/service";
import { addCharge } from "@/modules/billing/charges";

const num = (fd: FormData, k: string) => {
  const v = String(fd.get(k) ?? "").trim();
  return v === "" ? undefined : Number(v);
};
const soapOf = (fd: FormData) => ({ s: String(fd.get("s") ?? ""), o: String(fd.get("o") ?? ""), a: String(fd.get("a") ?? ""), p: String(fd.get("p") ?? "") });
const here = (fd: FormData) => `/encounters/${String(fd.get("encounterId"))}`;

export async function noteAction(fd: FormData) {
  const ctx = await requireCtx();
  await run(here(fd), async () => {
    const noteId = String(fd.get("noteId"));
    await saveDraftNote(ctx, noteId, soapOf(fd));
    if (fd.get("intent") === "sign") await signNote(ctx, noteId);
  });
}
export async function amendAction(fd: FormData) {
  const ctx = await requireCtx();
  await run(here(fd), async () => { await amendNote(ctx, String(fd.get("noteId")), soapOf(fd), String(fd.get("reason") ?? "")); });
}
export async function vitalsAction(fd: FormData) {
  const ctx = await requireCtx();
  await run(here(fd), async () => {
    const v = { systolic: num(fd, "systolic"), diastolic: num(fd, "diastolic"), heartRate: num(fd, "heartRate"), tempC: num(fd, "tempC"), spo2: num(fd, "spo2"), weightKg: num(fd, "weightKg") };
    await recordVitals(ctx, String(fd.get("encounterId")), Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)));
  });
}
export async function diagnosisAction(fd: FormData) {
  const ctx = await requireCtx();
  await run(here(fd), async () => {
    await addDiagnosis(ctx, String(fd.get("encounterId")), { code: String(fd.get("code") ?? ""), description: String(fd.get("description") ?? ""), primary: fd.get("primary") === "on" });
  });
}
export async function chargeAction(fd: FormData) {
  const ctx = await requireCtx();
  await run(here(fd), async () => {
    await addCharge(ctx, { encounterId: String(fd.get("encounterId")), serviceId: String(fd.get("serviceId")), qty: Number(fd.get("qty") ?? 1) });
  });
}
export async function completeAction(fd: FormData) {
  const ctx = await requireCtx();
  await run(here(fd), async () => {
    await completeEncounter(ctx, String(fd.get("encounterId")));
    return "/queue";
  });
}
