import { tenantCol } from "@/core/db";
import { dubaiDayRange } from "@/core/time";
import { AppError } from "@/core/errors";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import type { Appointment } from "@/modules/appointments/schema";
import type { Token } from "@/modules/queue/service";
import type { Encounter, Note } from "@/modules/emr/schema";

/** Doctor's day: consults, current patient, waiting, unsigned notes. */
export async function doctorDashboard(ctx: Ctx, f: { doctorId?: string; day: Date }) {
  assertPermission(ctx, "dashboard:view");
  assertPermission(ctx, "emr:view");
  let doctorId = f.doctorId;
  if (!doctorId) {
    const me = await tenantCol<{ _id: string }>(ctx.orgId, "staff").findOne({ userId: ctx.userId } as never);
    if (!me) throw new AppError("NOT_FOUND", "No doctor profile linked to this user");
    doctorId = me._id;
  }
  const { start, end } = dubaiDayRange(f.day);
  const appts = await tenantCol<Appointment>(ctx.orgId, "appointments").find({ doctorId, start: { $gte: start, $lt: end } } as never, { sort: { start: 1 } });
  const tokens = await tenantCol<Token>(ctx.orgId, "queue_tokens").find({ doctorId, checkedInAt: { $gte: start, $lt: end } } as never);
  const current = appts.find((a) => a.status === "in_consult") ?? null;
  const openEncounters = await tenantCol<Encounter>(ctx.orgId, "encounters").find({ doctorId, status: "open" } as never);
  const draftNotes = await tenantCol<Note>(ctx.orgId, "notes").find({ encounterId: { $in: openEncounters.map((e) => e._id) }, status: "draft" } as never);
  return {
    todaysConsultations: appts.filter((a) => a.status !== "cancelled" && a.status !== "no_show").length,
    currentPatient: current ? { appointmentId: current._id, patientId: current.patientId } : null,
    waitingPatients: tokens.filter((t) => t.status === "waiting").length,
    pendingNotes: draftNotes.length,
    recentEncounters: (await tenantCol<Encounter>(ctx.orgId, "encounters").find({ doctorId } as never, { sort: { openedAt: -1 }, limit: 10 })).map((e) => ({ id: e._id, patientId: e.patientId, status: e.status, openedAt: e.openedAt })),
  };
}
