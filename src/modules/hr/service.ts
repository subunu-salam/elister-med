import Decimal from "decimal.js";
import type { Decimal128 } from "mongodb";
import { z } from "zod";
import { tenantCol, withTransaction } from "@/core/db";
import { audit } from "@/core/audit";
import { nextSeq } from "@/core/counters";
import { newId } from "@/core/ids";
import { AppError } from "@/core/errors";
import { fromDecimal128, money, round2, sum, toDecimal128 } from "@/core/money";
import { assertPermission, type Ctx } from "@/core/rbac/authorize";
import { accountBySystem } from "@/modules/ledger/accounts";
import { postJournalSystem } from "@/modules/ledger/journal";
import { dubaiParts } from "@/core/time";

const amt = z.string().regex(/^\d+(\.\d{1,2})?$/);
const v = <T>(r: { success: true; data: T } | { success: false; error: { message: string } }): T => { if (!r.success) throw new AppError("VALIDATION", r.error.message); return r.data; };
const D = (x: string | number) => toDecimal128(money(x));

export type Employee = {
  _id: string; empNo: string; name: string; nameAr?: string; role: string; departmentId?: string; userId?: string; status: "active" | "terminated"; joinDate: Date;
  contract: { type: "limited" | "unlimited"; start: Date; end?: Date; basic: Decimal128; allowances: { name: string; amount: Decimal128 }[] };
  licence?: { authority: "DHA" | "DOH" | "MOHAP" | "DHCC" | "OTHER"; number: string; expiry: Date };
  emiratesIdExpiry?: Date; visaExpiry?: Date; passportExpiry?: Date; advanceBalance: Decimal128; bank?: { iban?: string; routingCode?: string };
};
const emps = (o: string) => tenantCol<Employee>(o, "employees");

export async function createEmployee(ctx: Ctx, input: {
  name: string; nameAr?: string; role: string; departmentId?: string; joinDate: Date; contractType: "limited" | "unlimited"; contractStart: Date; contractEnd?: Date; basic: string;
  allowances?: { name: string; amount: string }[]; licence?: { authority: "DHA" | "DOH" | "MOHAP" | "DHCC" | "OTHER"; number: string; expiry: Date };
  emiratesIdExpiry?: Date; visaExpiry?: Date; passportExpiry?: Date; iban?: string; userId?: string;
}): Promise<Employee> {
  assertPermission(ctx, "hr:create");
  const d = v(z.object({ name: z.string().min(2), role: z.string().min(2), basic: amt, contractType: z.enum(["limited", "unlimited"]), allowances: z.array(z.object({ name: z.string(), amount: amt })).default([]) }).passthrough().safeParse(input));
  const e: Employee = {
    _id: newId(), empNo: `EMP-${String(await nextSeq(ctx.orgId, "emp")).padStart(4, "0")}`, name: input.name, nameAr: input.nameAr, role: input.role, departmentId: input.departmentId, userId: input.userId,
    status: "active", joinDate: input.joinDate, advanceBalance: D(0), bank: input.iban ? { iban: input.iban } : undefined,
    contract: { type: input.contractType, start: input.contractStart, end: input.contractEnd, basic: D(d.basic), allowances: d.allowances.map((a) => ({ name: a.name, amount: D(a.amount) })) },
    licence: input.licence, emiratesIdExpiry: input.emiratesIdExpiry, visaExpiry: input.visaExpiry, passportExpiry: input.passportExpiry,
  };
  await withTransaction(async (s) => {
    await emps(ctx.orgId).insertOne(e, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "employee.create", resource: "employee", resourceId: e._id, after: { empNo: e.empNo, role: e.role } });
  });
  return e;
}
export async function listEmployees(ctx: Ctx) { assertPermission(ctx, "hr:view"); return emps(ctx.orgId).find({} as never, { sort: { empNo: 1 }, limit: 1000 }); }
export async function getEmployee(ctx: Ctx, id: string) { assertPermission(ctx, "hr:view"); const e = await emps(ctx.orgId).findOne({ _id: id } as never); if (!e) throw new AppError("NOT_FOUND", "Employee not found"); return e; }

/** Professional licence, Emirates ID, visa and passport expiries within `days` (or already expired). */
export async function documentExpiryAlerts(ctx: Ctx, days = 60) {
  assertPermission(ctx, "hr:view");
  const limit = Date.now() + days * 86400000;
  const out: { employeeId: string; empNo: string; name: string; document: string; expiry: Date; expired: boolean }[] = [];
  for (const e of await emps(ctx.orgId).find({ status: "active" } as never, { limit: 5000 })) {
    const docs: [string, Date | undefined][] = [[`${e.licence?.authority ?? ""} professional licence`, e.licence?.expiry], ["Emirates ID", e.emiratesIdExpiry], ["Residence visa", e.visaExpiry], ["Passport", e.passportExpiry]];
    for (const [document, expiry] of docs) if (expiry && expiry.getTime() <= limit) out.push({ employeeId: e._id, empNo: e.empNo, name: e.name, document, expiry, expired: expiry.getTime() < Date.now() });
  }
  return out.sort((a, b) => a.expiry.getTime() - b.expiry.getTime());
}

// ---------- Attendance, shifts, overtime ----------
export type Attendance = { _id: string; employeeId: string; day: string; clockIn: Date; clockOut?: Date; hours?: number; overtimeHours?: number };
const att = (o: string) => tenantCol<Attendance>(o, "attendance");
export type OrgHrConfig = { standardDailyHours: number; overtimeMultiplier: number; workingDaysPerMonth: number; gratuity?: { firstYearsRate: number; firstYears: number; laterRate: number; capMonths: number } };

export async function setHrConfig(ctx: Ctx, cfg: OrgHrConfig): Promise<void> {
  assertPermission(ctx, "hr:approve");
  v(z.object({ standardDailyHours: z.number().positive().max(24), overtimeMultiplier: z.number().min(1).max(5), workingDaysPerMonth: z.number().min(1).max(31) }).passthrough().safeParse(cfg));
  await withTransaction(async (s) => {
    await tenantCol(ctx.orgId, "hr_config").updateOne({ key: "main" } as never, { $set: { cfg, by: ctx.userId, at: new Date() } } as never, s, { upsert: true });
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "hr.config", resource: "hr_config", resourceId: "main", after: cfg });
  });
}
async function hrConfig(ctx: Ctx): Promise<OrgHrConfig> {
  const c = await tenantCol<{ cfg: OrgHrConfig }>(ctx.orgId, "hr_config").findOne({ key: "main" } as never);
  if (!c) throw new AppError("CONFLICT", "HR policy is not configured for this organisation (hours, overtime, working days). Set it first; nothing is assumed.");
  return c.cfg;
}

export async function clockIn(ctx: Ctx, employeeId: string, at = new Date()): Promise<Attendance> {
  assertPermission(ctx, "hr:create");
  await getEmployee(ctx, employeeId);
  const a: Attendance = { _id: newId(), employeeId, day: dubaiParts(at).ymd, clockIn: at };
  try { await att(ctx.orgId).insertOne(a); } catch (e) { if ((e as { code?: number }).code === 11000) throw new AppError("CONFLICT", "Already clocked in today"); throw e; }
  return a;
}
export async function clockOut(ctx: Ctx, employeeId: string, at = new Date()): Promise<Attendance> {
  assertPermission(ctx, "hr:create");
  const cfg = await hrConfig(ctx);
  const day = dubaiParts(at).ymd;
  const a = await att(ctx.orgId).findOne({ employeeId, day } as never);
  if (!a) throw new AppError("NOT_FOUND", "No clock-in today");
  if (a.clockOut) throw new AppError("CONFLICT", "Already clocked out");
  if (at <= a.clockIn) throw new AppError("VALIDATION", "Clock-out must be after clock-in");
  const hours = Math.round(((at.getTime() - a.clockIn.getTime()) / 3600000) * 100) / 100;
  const overtimeHours = Math.max(0, Math.round((hours - cfg.standardDailyHours) * 100) / 100);
  await att(ctx.orgId).updateOne({ _id: a._id } as never, { $set: { clockOut: at, hours, overtimeHours } } as never);
  return { ...a, clockOut: at, hours, overtimeHours };
}
export async function listAttendance(ctx: Ctx, employeeId: string, month: string) { assertPermission(ctx, "hr:view"); return att(ctx.orgId).find({ employeeId, day: { $regex: `^${month}` } } as never, { sort: { day: 1 } }); }

export type Shift = { _id: string; employeeId: string; day: string; start: string; end: string; branchId?: string };
export async function assignShift(ctx: Ctx, s0: { employeeId: string; day: string; start: string; end: string }): Promise<Shift> {
  assertPermission(ctx, "hr:create");
  v(z.object({ employeeId: z.string(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }).safeParse(s0));
  if (s0.end <= s0.start) throw new AppError("VALIDATION", "Shift end must be after start");
  const dup = await tenantCol<Shift>(ctx.orgId, "shifts").findOne({ employeeId: s0.employeeId, day: s0.day } as never);
  if (dup) throw new AppError("CONFLICT", "Employee already has a shift that day");
  const sh: Shift = { _id: newId(), ...s0, branchId: ctx.branchId };
  await tenantCol<Shift>(ctx.orgId, "shifts").insertOne(sh);
  return sh;
}

// ---------- Leave ----------
export type LeaveType = { _id: string; code: string; name: string; daysPerYear: number; paid: boolean };
export type LeaveRequest = { _id: string; employeeId: string; typeCode: string; from: string; to: string; days: number; status: "pending" | "approved" | "rejected"; requestedBy: string; decidedBy?: string; reason?: string };
const leaveTypes = (o: string) => tenantCol<LeaveType>(o, "leave_types");
const leaves = (o: string) => tenantCol<LeaveRequest>(o, "leave_requests");

/** Leave entitlements are configuration (no hard-coded statutory values). */
export async function defineLeaveType(ctx: Ctx, input: { code: string; name: string; daysPerYear: number; paid: boolean }): Promise<LeaveType> {
  assertPermission(ctx, "hr:approve");
  v(z.object({ code: z.string().min(2), name: z.string().min(2), daysPerYear: z.number().min(0).max(366), paid: z.boolean() }).safeParse(input));
  const t: LeaveType = { _id: `${ctx.orgId}:${input.code}`, ...input };
  await leaveTypes(ctx.orgId).updateOne({ code: input.code } as never, { $set: input, $setOnInsert: { _id: t._id } } as never, undefined, { upsert: true });
  return t;
}
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;

export async function leaveBalance(ctx: Ctx, employeeId: string, typeCode: string, year: number) {
  assertPermission(ctx, "hr:view");
  const t = await leaveTypes(ctx.orgId).findOne({ code: typeCode } as never);
  if (!t) throw new AppError("NOT_FOUND", "Leave type not defined");
  const used = (await leaves(ctx.orgId).find({ employeeId, typeCode, status: "approved", from: { $regex: `^${year}` } } as never)).reduce((a, l) => a + l.days, 0);
  return { entitlement: t.daysPerYear, used, remaining: t.daysPerYear - used };
}
export async function requestLeave(ctx: Ctx, input: { employeeId: string; typeCode: string; from: string; to: string; reason?: string }): Promise<LeaveRequest> {
  assertPermission(ctx, "hr:create");
  const days = daysBetween(input.from, input.to);
  if (!(days >= 1)) throw new AppError("VALIDATION", "Leave end must not be before start");
  const bal = await leaveBalance(ctx, input.employeeId, input.typeCode, Number(input.from.slice(0, 4)));
  if (days > bal.remaining) throw new AppError("VALIDATION", `Only ${bal.remaining} day(s) of this leave remain`);
  const overlap = await leaves(ctx.orgId).find({ employeeId: input.employeeId, status: { $in: ["pending", "approved"] }, from: { $lte: input.to }, to: { $gte: input.from } } as never);
  if (overlap.length) throw new AppError("CONFLICT", "Overlaps another leave request");
  const r: LeaveRequest = { _id: newId(), ...input, days, status: "pending", requestedBy: ctx.userId };
  await leaves(ctx.orgId).insertOne(r);
  return r;
}
export async function decideLeave(ctx: Ctx, id: string, approved: boolean): Promise<void> {
  assertPermission(ctx, "hr:approve");
  const res = await leaves(ctx.orgId).updateOne({ _id: id, status: "pending", requestedBy: { $ne: ctx.userId } } as never, { $set: { status: approved ? "approved" : "rejected", decidedBy: ctx.userId } } as never);
  if (res.matchedCount === 0) throw new AppError("CONFLICT", "Request not found, already decided, or you submitted it yourself");
}
export async function listLeave(ctx: Ctx) { assertPermission(ctx, "hr:view"); return leaves(ctx.orgId).find({} as never, { sort: { from: -1 }, limit: 200 }); }

// ---------- Advances ----------
export async function grantAdvance(ctx: Ctx, input: { employeeId: string; amount: string; idempotencyKey: string }): Promise<void> {
  assertPermission(ctx, "hr:approve");
  assertPermission(ctx, "hr:approve");
  const d = v(z.object({ employeeId: z.string(), amount: amt, idempotencyKey: z.string().min(1) }).safeParse(input));
  await withTransaction(async (s) => {
    const e = await emps(ctx.orgId).findOne({ _id: d.employeeId } as never, s);
    if (!e) throw new AppError("NOT_FOUND", "Employee not found");
    await postJournalSystem(ctx, { date: new Date(), memo: `Salary advance ${e.empNo}`, sourceRef: { type: "advance", id: d.idempotencyKey }, idempotencyKey: `advance:${d.idempotencyKey}`,
      lines: [{ accountId: (await accountBySystem(ctx.orgId, "employee_advances"))._id, debit: d.amount }, { accountId: (await accountBySystem(ctx.orgId, "bank"))._id, credit: d.amount }] }, s);
    const done = await tenantCol(ctx.orgId, "advances").findOne({ key: d.idempotencyKey } as never, s);
    if (!done) {
      await tenantCol(ctx.orgId, "advances").insertOne({ _id: newId(), key: d.idempotencyKey, employeeId: e._id, amount: D(d.amount), at: new Date() } as never, s);
      await emps(ctx.orgId).updateOne({ _id: e._id } as never, { $set: { advanceBalance: toDecimal128(fromDecimal128(e.advanceBalance).plus(d.amount)) } } as never, s);
    }
  });
}

// ---------- Payroll ----------
export type PayrollLine = { employeeId: string; empNo: string; name: string; basic: Decimal128; allowances: Decimal128; overtime: Decimal128; unpaidLeaveDeduction: Decimal128; advanceRecovery: Decimal128; gross: Decimal128; net: Decimal128 };
export type PayrollRun = { _id: string; period: string; status: "draft" | "approved" | "paid"; lines: PayrollLine[]; totalGross: Decimal128; totalNet: Decimal128; preparedBy: string; approvedBy?: string; journalEntryId?: string; paymentJournalId?: string; at: Date };
const runs = (o: string) => tenantCol<PayrollRun>(o, "payroll_runs");

/** Prepares a payroll run for a month (YYYY-MM). Overtime = hours x hourly rate x configured multiplier; unpaid leave deducted by day rate; advances recovered up to net pay. */
export async function preparePayroll(ctx: Ctx, period: string, opts: { advanceRecoveryPerMonth?: string } = {}): Promise<PayrollRun> {
  assertPermission(ctx, "hr:create");
  if (!/^\d{4}-\d{2}$/.test(period)) throw new AppError("VALIDATION", "Period must be YYYY-MM");
  const cfg = await hrConfig(ctx);
  if (await runs(ctx.orgId).findOne({ period } as never)) throw new AppError("CONFLICT", `Payroll for ${period} already exists`);
  const lines: PayrollLine[] = [];
  const unpaid = new Set((await leaveTypes(ctx.orgId).find({ paid: false } as never)).map((t) => t.code));
  for (const e of await emps(ctx.orgId).find({ status: "active" } as never, { limit: 5000 })) {
    const basic = fromDecimal128(e.contract.basic), allow = sum(e.contract.allowances.map((a) => fromDecimal128(a.amount)));
    const monthly = basic.plus(allow);
    const dayRate = monthly.div(cfg.workingDaysPerMonth), hourRate = dayRate.div(cfg.standardDailyHours);
    const otHours = (await att(ctx.orgId).find({ employeeId: e._id, day: { $regex: `^${period}` } } as never)).reduce((a, r) => a + (r.overtimeHours ?? 0), 0);
    const overtime = round2(hourRate.times(otHours).times(cfg.overtimeMultiplier));
    const unpaidDays = (await leaves(ctx.orgId).find({ employeeId: e._id, status: "approved", from: { $regex: `^${period}` } } as never)).filter((l) => unpaid.has(l.typeCode)).reduce((a, l) => a + l.days, 0);
    const deduction = round2(dayRate.times(unpaidDays));
    const gross = monthly.plus(overtime).minus(deduction);
    const adv = Decimal.min(fromDecimal128(e.advanceBalance), money(opts.advanceRecoveryPerMonth ?? "0"), gross);
    lines.push({ employeeId: e._id, empNo: e.empNo, name: e.name, basic: toDecimal128(basic), allowances: toDecimal128(allow), overtime: toDecimal128(overtime), unpaidLeaveDeduction: toDecimal128(deduction), advanceRecovery: toDecimal128(adv), gross: toDecimal128(gross), net: toDecimal128(gross.minus(adv)) });
  }
  if (!lines.length) throw new AppError("VALIDATION", "No active employees");
  const run: PayrollRun = { _id: newId(), period, status: "draft", lines, totalGross: toDecimal128(sum(lines.map((l) => fromDecimal128(l.gross)))), totalNet: toDecimal128(sum(lines.map((l) => fromDecimal128(l.net)))), preparedBy: ctx.userId, at: new Date() };
  await withTransaction(async (s) => {
    await runs(ctx.orgId).insertOne(run, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "payroll.prepare", resource: "payroll_run", resourceId: run._id, after: { period, net: fromDecimal128(run.totalNet).toFixed(2) } });
  });
  return run;
}

/** Approval (different person) posts: Dr Salaries (gross) / Cr Payroll liabilities (net) / Cr Employee advances (recoveries). */
export async function approvePayroll(ctx: Ctx, runId: string): Promise<PayrollRun> {
  assertPermission(ctx, "hr:approve");
  return withTransaction(async (s) => {
    const r = await runs(ctx.orgId).findOne({ _id: runId } as never, s);
    if (!r) throw new AppError("NOT_FOUND", "Payroll run not found");
    if (r.status !== "draft") throw new AppError("CONFLICT", `Payroll is ${r.status}`);
    if (r.preparedBy === ctx.userId) throw new AppError("FORBIDDEN", "You cannot approve a payroll you prepared");
    const gross = fromDecimal128(r.totalGross), net = fromDecimal128(r.totalNet), adv = gross.minus(net);
    const je = await postJournalSystem(ctx, { date: new Date(), memo: `Payroll ${r.period}`, sourceRef: { type: "payroll", id: r._id }, idempotencyKey: `payroll:${r._id}`,
      lines: [
        { accountId: (await accountBySystem(ctx.orgId, "salaries"))._id, debit: gross.toFixed(2) },
        { accountId: (await accountBySystem(ctx.orgId, "payroll_liability"))._id, credit: net.toFixed(2) },
        ...(adv.gt(0) ? [{ accountId: (await accountBySystem(ctx.orgId, "employee_advances"))._id, credit: adv.toFixed(2) }] : []),
      ] }, s);
    for (const l of r.lines) if (fromDecimal128(l.advanceRecovery).gt(0)) {
      const e = (await emps(ctx.orgId).findOne({ _id: l.employeeId } as never, s))!;
      await emps(ctx.orgId).updateOne({ _id: e._id } as never, { $set: { advanceBalance: toDecimal128(fromDecimal128(e.advanceBalance).minus(fromDecimal128(l.advanceRecovery))) } } as never, s);
    }
    await runs(ctx.orgId).updateOne({ _id: r._id, status: "draft" } as never, { $set: { status: "approved", approvedBy: ctx.userId, journalEntryId: je._id } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "payroll.approve", resource: "payroll_run", resourceId: r._id });
    return { ...r, status: "approved", journalEntryId: je._id };
  });
}

export async function payPayroll(ctx: Ctx, runId: string): Promise<PayrollRun> {
  assertPermission(ctx, "ledger:create");
  return withTransaction(async (s) => {
    const r = await runs(ctx.orgId).findOne({ _id: runId } as never, s);
    if (!r) throw new AppError("NOT_FOUND", "Payroll run not found");
    if (r.status !== "approved") throw new AppError("CONFLICT", `Payroll is ${r.status}; it must be approved before payment`);
    const net = fromDecimal128(r.totalNet);
    const je = await postJournalSystem(ctx, { date: new Date(), memo: `Payroll payment ${r.period}`, sourceRef: { type: "payroll_payment", id: r._id }, idempotencyKey: `payrollpay:${r._id}`,
      lines: [{ accountId: (await accountBySystem(ctx.orgId, "payroll_liability"))._id, debit: net.toFixed(2) }, { accountId: (await accountBySystem(ctx.orgId, "bank"))._id, credit: net.toFixed(2) }] }, s);
    await runs(ctx.orgId).updateOne({ _id: r._id, status: "approved" } as never, { $set: { status: "paid", paymentJournalId: je._id } } as never, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "payroll.pay", resource: "payroll_run", resourceId: r._id });
    return { ...r, status: "paid", paymentJournalId: je._id };
  });
}

/** Bank-transfer file for a paid or approved run. This is a generic CSV: the official WPS SIF layout is bank/MOHRE specific and must be configured before real use. */
export async function wpsExport(ctx: Ctx, runId: string): Promise<{ filename: string; csv: string; notice: string }> {
  assertPermission(ctx, "hr:export");
  const r = await runs(ctx.orgId).findOne({ _id: runId } as never);
  if (!r) throw new AppError("NOT_FOUND", "Payroll run not found");
  if (r.status === "draft") throw new AppError("CONFLICT", "Approve the payroll before exporting");
  const emap = new Map((await emps(ctx.orgId).find({ _id: { $in: r.lines.map((l) => l.employeeId) } } as never)).map((e) => [e._id, e]));
  const rows = [["employee_no", "name", "iban", "net_pay_aed"], ...r.lines.map((l) => [l.empNo, l.name, emap.get(l.employeeId)?.bank?.iban ?? "", fromDecimal128(l.net).toFixed(2)])];
  return { filename: `payroll-${r.period}.csv`, csv: rows.map((x) => x.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n"), notice: "Generic CSV. Not the official WPS SIF format; configure the bank/MOHRE layout before submission." };
}
export async function listPayrollRuns(ctx: Ctx) { assertPermission(ctx, "hr:view"); return runs(ctx.orgId).find({} as never, { sort: { period: -1 }, limit: 50 }); }

// ---------- End of service ----------
export async function setGratuityPolicy(ctx: Ctx, g: NonNullable<OrgHrConfig["gratuity"]>): Promise<void> {
  assertPermission(ctx, "hr:approve");
  const cfg = await hrConfig(ctx);
  await tenantCol(ctx.orgId, "hr_config").updateOne({ key: "main" } as never, { $set: { cfg: { ...cfg, gratuity: g } } } as never);
}
/** Uses ONLY the organisation's configured gratuity policy; there is no built-in statutory default. Returns null-policy as an error. */
export async function calculateGratuity(ctx: Ctx, input: { employeeId: string; endDate: Date }) {
  assertPermission(ctx, "hr:view");
  const cfg = await hrConfig(ctx);
  if (!cfg.gratuity) throw new AppError("CONFLICT", "No end-of-service policy configured. Have HR/legal enter the applicable rule set before calculating.");
  const e = await getEmployee(ctx, input.employeeId);
  const years = (input.endDate.getTime() - e.joinDate.getTime()) / (365.25 * 86400000);
  if (years < 0) throw new AppError("VALIDATION", "End date is before the join date");
  const dailyBasic = fromDecimal128(e.contract.basic).div(30);
  const g = cfg.gratuity;
  const first = Math.min(years, g.firstYears), later = Math.max(0, years - g.firstYears);
  let amount = dailyBasic.times(g.firstYearsRate).times(first).plus(dailyBasic.times(g.laterRate).times(later));
  amount = Decimal.min(amount, fromDecimal128(e.contract.basic).times(g.capMonths));
  return { years: Math.round(years * 100) / 100, amount: round2(amount), policy: g, note: "Calculated from the organisation-configured policy; validate against current law before payment." };
}
