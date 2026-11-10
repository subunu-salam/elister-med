"use server";
import { revalidatePath } from "next/cache";
import { AppError } from "@/core/errors";
import { run, requireCtx } from "@/lib/session";
import { bookAppointment, cancelAppointment, markNoShow, rescheduleAppointment } from "@/modules/appointments/service";
import { checkIn } from "@/modules/queue/service";

const back = (date: string) => `/appointments?date=${date}`;

export async function bookAction(fd: FormData) {
  const ctx = await requireCtx();
  const date = String(fd.get("date"));
  await run(back(date), async () => {
    const start = new Date(`${date}T${String(fd.get("time"))}:00+04:00`);
    const mins = Number(fd.get("minutes") ?? 20);
    const patientId = String(fd.get("patientId") ?? "");
    if (!patientId) throw new AppError("VALIDATION", "Choose a patient from the search results");
    await bookAppointment(ctx, {
      patientId, doctorId: String(fd.get("doctorId")), start, end: new Date(start.getTime() + mins * 60000),
      type: String(fd.get("type") ?? "consultation"),
    });
  });
}

export async function checkInAction(fd: FormData) {
  const ctx = await requireCtx();
  await run(back(String(fd.get("date"))), async () => {
    await checkIn(ctx, String(fd.get("id")), { priority: fd.get("priority") === "on" ? 1 : 0 });
  });
}
export async function noShowAction(fd: FormData) {
  const ctx = await requireCtx();
  await run(back(String(fd.get("date"))), async () => { await markNoShow(ctx, String(fd.get("id"))); });
}
export async function cancelAction(fd: FormData) {
  const ctx = await requireCtx();
  await run(back(String(fd.get("date"))), async () => { await cancelAppointment(ctx, String(fd.get("id")), String(fd.get("reason") ?? "")); });
}

/** Called by the drag-and-drop grid. Same service as any other reschedule, so the same rules apply. */
export async function rescheduleAction(id: string, startIso: string, endIso: string, doctorId: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireCtx();
  try {
    await rescheduleAppointment(ctx, id, new Date(startIso), new Date(endIso), doctorId);
    revalidatePath("/appointments");
    return { ok: true };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, error: e.message };
    throw e;
  }
}
