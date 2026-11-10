export type ApptStatus = "booked" | "checked_in" | "in_consult" | "completed" | "cancelled" | "no_show";
export const ACTIVE: ApptStatus[] = ["booked", "checked_in", "in_consult"];

export const TRANSITIONS: Record<ApptStatus, ApptStatus[]> = {
  booked: ["checked_in", "cancelled", "no_show"],
  checked_in: ["in_consult", "cancelled"],
  in_consult: ["completed"],
  completed: [],
  cancelled: [],
  no_show: [],
};

export type Appointment = {
  _id: string;
  patientId: string;
  doctorId: string;
  branchId: string;
  start: Date;
  end: Date;
  type: string;
  status: ApptStatus;
  notes?: string;
  checkInToken?: string;
  createdAt: Date;
  createdBy: string;
  history: { status: ApptStatus; at: Date; by: string; reason?: string }[];
};

export type Staff = {
  _id: string;
  name: string;
  workDays: number[];
  workStart: string;
  workEnd: string;
  slotMinutes: number;
  branchId: string;
  active: boolean;
};

export type TimeOff = {
  _id: string;
  doctorId: string | null;
  start: Date;
  end: Date;
  reason: string;
  kind: "leave" | "holiday";
};
