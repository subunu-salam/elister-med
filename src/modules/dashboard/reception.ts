import { tenantCol } from "@/core/db";
import { dubaiDayRange } from "@/core/time";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import type { Appointment } from "@/modules/appointments/schema";
import type { Token } from "@/modules/queue/service";

/** Live reception control centre numbers for one Dubai day. */
export async function receptionDashboard(ctx: Ctx, f: { day: Date; branchId?: string }) {
  assertPermission(ctx, "dashboard:view");
  assertPermission(ctx, "appointments:view");
  const { start, end } = dubaiDayRange(f.day);
  const branch = f.branchId ? { branchId: f.branchId } : {};
  const appts = await tenantCol<Appointment>(ctx.orgId, "appointments").find({ start: { $gte: start, $lt: end }, ...branch } as never, { sort: { start: 1 }, limit: 1000 });
  const tokens = await tenantCol<Token>(ctx.orgId, "queue_tokens").find({ checkedInAt: { $gte: start, $lt: end }, ...branch } as never, { limit: 1000 });
  const count = (s: string) => appts.filter((a) => a.status === s).length;
  const doctors = await tenantCol<{ _id: string; name: string }>(ctx.orgId, "staff").find({ active: true, role: "doctor" } as never);
  return {
    todaysAppointments: appts.length,
    expectedArrivals: count("booked"),
    checkedIn: count("checked_in"),
    inConsult: count("in_consult"),
    completed: count("completed"),
    cancelled: count("cancelled"),
    noShows: count("no_show"),
    walkIns: appts.filter((a) => a.type === "walk_in").length,
    patientsWaiting: tokens.filter((t) => t.status === "waiting").length,
    doctors: doctors.map((d) => ({ id: d._id, name: d.name, busy: appts.some((a) => a.doctorId === d._id && a.status === "in_consult") })),
    appointments: appts.map((a) => ({ id: a._id, patientId: a.patientId, doctorId: a.doctorId, start: a.start, status: a.status })),
  };
}
