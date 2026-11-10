"use server";
import { run, requireCtx } from "@/lib/session";
import { callNext, skipToken } from "@/modules/queue/service";
import { openEncounter } from "@/modules/emr/service";

export async function callNextAction(fd: FormData) {
  const ctx = await requireCtx();
  await run("/queue", async () => { await callNext(ctx, String(fd.get("doctorId"))); });
}
export async function skipAction(fd: FormData) {
  const ctx = await requireCtx();
  await run("/queue", async () => { await skipToken(ctx, String(fd.get("tokenId"))); });
}
export async function startConsultAction(fd: FormData) {
  const ctx = await requireCtx();
  await run("/queue", async () => {
    const w = await openEncounter(ctx, String(fd.get("appointmentId")));
    return `/encounters/${w.encounter._id}`;
  });
}
