import type { ClientSession } from "mongodb";
import { tenantCol } from "@/core/db";
import { AppError } from "@/core/errors";
import { dubaiParts, hhmmToMinutes } from "@/core/time";
import { ACTIVE, type Appointment, type Staff, type TimeOff } from "./schema";

/**
 * Throws if the interval is not bookable. `excludeId` is skipped in the overlap check (reschedule).
 * Run inside the doctor-day lock transaction so the overlap check is race-free.
 */
export async function assertSlotFree(
  orgId: string,
  doctorId: string,
  start: Date,
  end: Date,
  s?: ClientSession,
  excludeId?: string,
): Promise<Staff> {
  if (!(end > start)) throw new AppError("VALIDATION", "End must be after start");
  const doc = await tenantCol<Staff>(orgId, "staff").findOne({ _id: doctorId } as never, s);
  if (!doc || !doc.active) throw new AppError("NOT_FOUND", "Doctor not found");

  const a = dubaiParts(start);
  const b = dubaiParts(new Date(end.getTime() - 1));
  if (a.ymd !== b.ymd) throw new AppError("VALIDATION", "Appointment cannot span days");
  if (!doc.workDays.includes(a.dow)) throw new AppError("CONFLICT", "Doctor does not work this day");
  if (a.minutes < hhmmToMinutes(doc.workStart) || b.minutes + 1 > hhmmToMinutes(doc.workEnd)) {
    throw new AppError("CONFLICT", "Outside doctor working hours");
  }

  const off = await tenantCol<TimeOff>(orgId, "time_off").find(
    { start: { $lt: end }, end: { $gt: start }, $or: [{ doctorId }, { doctorId: null }] } as never,
    { session: s },
  );
  if (off.length) throw new AppError("CONFLICT", `Blocked: ${off[0].kind} (${off[0].reason})`);

  const clash = await tenantCol<Appointment>(orgId, "appointments").find(
    {
      doctorId,
      status: { $in: ACTIVE },
      start: { $lt: end },
      end: { $gt: start },
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    } as never,
    { limit: 1, session: s },
  );
  if (clash.length) throw new AppError("CONFLICT", "Slot already booked");
  return doc;
}
