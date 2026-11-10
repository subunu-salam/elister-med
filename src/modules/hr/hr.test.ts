import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { fromDecimal128, money } from "@/core/money";
import { ctxFor } from "@/test/helpers";
import { ensureChartOfAccounts } from "@/modules/ledger/accounts";
import { trialBalance } from "@/modules/reports/trialBalance";
import {
  createEmployee, documentExpiryAlerts, setHrConfig, clockIn, clockOut, defineLeaveType, requestLeave, decideLeave, leaveBalance, grantAdvance, preparePayroll,
  approvePayroll, payPayroll, wpsExport, setGratuityPolicy, calculateGratuity,
} from "./service";

const ORG = "org-hr";
const hr = ctxFor(["hr_manager"], ORG, "hr1", "br1");
const fin = ctxFor(["finance_manager"], ORG, "fin1", "br1");
const D = (iso: string) => new Date(`${iso}T09:00:00+04:00`);
const period = "2026-06";
let emp1 = "", emp2 = "";

async function bal(code: string) { return (await trialBalance(fin, {})).rows.find((r) => r.code === code)?.balance ?? money(0); }

beforeAll(async () => {
  await ensureIndexes();
  await ensureChartOfAccounts(ORG);
  const y = new Date().getUTCFullYear();
  for (const year of [y - 1, y, y + 1]) for (let m = 1; m <= 12; m++)
    await tenantCol<any>(ORG, "fiscal_periods").insertOne({ _id: `${ORG}:${year}-${m}`, year, month: m, status: "open", start: new Date(Date.UTC(year, m - 1, 1, -4)), end: new Date(Date.UTC(year, m, 1, -4)) });
  emp1 = (await createEmployee(hr, { name: "Nurse Noor", role: "nurse", joinDate: D("2020-01-01"), contractType: "limited", contractStart: D("2024-01-01"), basic: "6000.00", allowances: [{ name: "Housing", amount: "3000.00" }], licence: { authority: "DHA", number: "N-1", expiry: new Date(Date.now() + 30 * 86400000) }, emiratesIdExpiry: new Date(Date.now() - 86400000), iban: "AE000000000000000000001" }))._id;
  emp2 = (await createEmployee(hr, { name: "Admin Adel", role: "admin", joinDate: D("2022-01-01"), contractType: "unlimited", contractStart: D("2022-01-01"), basic: "3000.00", visaExpiry: new Date(Date.now() + 400 * 86400000) }))._id;
});
afterAll(async () => { await closeClient(); });

describe("HR", () => {
  it("nothing is assumed: payroll, attendance and gratuity refuse to run without configured policy", async () => {
    await expect(clockOut(hr, emp1)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(preparePayroll(hr, period)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(calculateGratuity(hr, { employeeId: emp1, endDate: D("2026-01-01") })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(setHrConfig(ctxFor(["receptionist"], ORG), { standardDailyHours: 8, overtimeMultiplier: 1.25, workingDaysPerMonth: 26 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await setHrConfig(fin, { standardDailyHours: 8, overtimeMultiplier: 1.25, workingDaysPerMonth: 26 });
  });

  it("licence, Emirates ID and visa expiry alerts (expired and upcoming)", async () => {
    const a = await documentExpiryAlerts(hr, 60);
    expect(a.map((x) => x.document)).toEqual(expect.arrayContaining(["Emirates ID", "DHA professional licence"]));
    expect(a.find((x) => x.document === "Emirates ID")!.expired).toBe(true);
    expect(a.some((x) => x.document === "Residence visa")).toBe(false);
  });

  it("attendance computes hours and overtime from the configured standard day; one clock-in per day", async () => {
    await clockIn(hr, emp1, new Date("2026-06-02T05:00:00Z"));
    await expect(clockIn(hr, emp1, new Date("2026-06-02T05:30:00Z"))).rejects.toMatchObject({ code: "CONFLICT" });
    const r = await clockOut(hr, emp1, new Date("2026-06-02T15:00:00Z"));
    expect(r.hours).toBe(10);
    expect(r.overtimeHours).toBe(2);
    await expect(clockOut(hr, emp1, new Date("2026-06-02T16:00:00Z"))).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("leave: balances from configured entitlement, no overlap, requester cannot approve own request", async () => {
    await defineLeaveType(fin, { code: "ANNUAL", name: "Annual leave", daysPerYear: 10, paid: true });
    await defineLeaveType(fin, { code: "UNPAID", name: "Unpaid leave", daysPerYear: 30, paid: false });
    const r = await requestLeave(hr, { employeeId: emp2, typeCode: "ANNUAL", from: "2026-06-08", to: "2026-06-10" });
    await decideLeave(fin, r._id, true);
    expect((await leaveBalance(hr, emp2, "ANNUAL", 2026)).remaining).toBe(7);
    await expect(requestLeave(hr, { employeeId: emp2, typeCode: "ANNUAL", from: "2026-06-09", to: "2026-06-09" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(requestLeave(hr, { employeeId: emp2, typeCode: "ANNUAL", from: "2026-07-01", to: "2026-07-20" })).rejects.toMatchObject({ code: "VALIDATION" });
    const u = await requestLeave(hr, { employeeId: emp2, typeCode: "UNPAID", from: "2026-06-15", to: "2026-06-16" });
    await expect(decideLeave(hr, u._id, true)).rejects.toMatchObject({ code: "CONFLICT" }); // hr_manager submitted it
    await decideLeave(fin, u._id, true);
  });

  it("payroll: overtime, unpaid-leave deduction, advance recovery; four-eyes; balanced journals; export", async () => {
    await grantAdvance(fin, { employeeId: emp1, amount: "500.00", idempotencyKey: "adv-1" });
    await grantAdvance(fin, { employeeId: emp1, amount: "500.00", idempotencyKey: "adv-1" });
    const run = await preparePayroll(hr, period, { advanceRecoveryPerMonth: "300.00" });
    await expect(preparePayroll(hr, period)).rejects.toMatchObject({ code: "CONFLICT" });
    const l1 = run.lines.find((l) => l.employeeId === emp1)!, l2 = run.lines.find((l) => l.employeeId === emp2)!;
    expect(fromDecimal128(l1.overtime).toFixed(2)).toBe("108.17"); // 9000/26/8 x 2h x 1.25
    expect(fromDecimal128(l1.advanceRecovery).toFixed(2)).toBe("300.00");
    expect(fromDecimal128(l2.unpaidLeaveDeduction).toFixed(2)).toBe("230.77"); // 2 x 3000/26
    expect(fromDecimal128(l2.net).toFixed(2)).toBe("2769.23");
    await expect(approvePayroll(hr, run._id)).rejects.toMatchObject({ code: "FORBIDDEN" }); // preparer cannot approve
    await expect(payPayroll(fin, run._id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(wpsExport(hr, run._id)).rejects.toMatchObject({ code: "CONFLICT" });
    await approvePayroll(fin, run._id);
    expect((await bal("2200")).negated().toFixed(2)).toBe(fromDecimal128(run.totalNet).toFixed(2));
    await payPayroll(fin, run._id);
    expect((await bal("2200")).toFixed(2)).toBe("0.00");
    const exp = await wpsExport(hr, run._id);
    expect(exp.csv).toContain("Nurse Noor");
    expect(exp.notice).toMatch(/Not the official WPS/);
    expect(fromDecimal128((await tenantCol<any>(ORG, "employees").findOne({ _id: emp1 })).advanceBalance).toFixed(2)).toBe("200.00");
    const tb = await trialBalance(fin, {});
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
  });

  it("gratuity uses only the configured policy and is capped", async () => {
    await setGratuityPolicy(fin, { firstYearsRate: 21, firstYears: 5, laterRate: 30, capMonths: 24 });
    const g = await calculateGratuity(hr, { employeeId: emp1, endDate: D("2026-01-01") });
    expect(g.amount.gt(0)).toBe(true);
    expect(g.policy.capMonths).toBe(24);
    await expect(calculateGratuity(hr, { employeeId: emp1, endDate: D("2010-01-01") })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
