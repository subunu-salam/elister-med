import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureIndexes, closeClient, tenantCol } from "@/core/db";
import { toDecimal128, money } from "@/core/money";
import { ctxFor } from "@/test/helpers";
import { ensureChartOfAccounts } from "@/modules/ledger/accounts";
import { postJournal } from "@/modules/ledger/journal";
import { pnl } from "./pnl";
import { arAging } from "./arAging";
import { revenueBy } from "./revenueBy";
import { executiveDashboard } from "@/modules/dashboard/executive";
import { receptionDashboard } from "@/modules/dashboard/reception";
import { doctorDashboard } from "@/modules/dashboard/doctor";
import { accountsDashboard } from "@/modules/dashboard/accounts";

const ORG = "org-reports";
const acc = ctxFor(["accountant"], ORG, "acc");
const fin = ctxFor(["finance_manager"], ORG, "fin");
const d = (iso: string) => new Date(`${iso}T12:00:00+04:00`);
const acct = (c: string) => `${ORG}:${c}`;
let k = 0;

const sale = (iso: string, revCode: string, amt: string, doctorId?: string, departmentId?: string) =>
  postJournal(acc, {
    date: d(iso), memo: "sale", idempotencyKey: `s-${k++}`, sourceRef: { type: "fixture", id: String(k) },
    lines: [{ accountId: acct("1000"), debit: amt }, { accountId: acct(revCode), credit: amt, dims: { doctorId, departmentId } }],
  });

const NOV = { from: new Date("2026-11-01T00:00:00+04:00"), to: new Date("2026-12-01T00:00:00+04:00") };
const OCT = { from: new Date("2026-10-01T00:00:00+04:00"), to: new Date("2026-11-01T00:00:00+04:00") };

beforeAll(async () => {
  await ensureIndexes();
  await ensureChartOfAccounts(ORG);
  for (const [y, m] of [[2026, 10], [2026, 11]])
    await tenantCol<any>(ORG, "fiscal_periods").insertOne({ _id: `${ORG}:${y}-${m}`, year: y, month: m, status: "open", start: new Date(Date.UTC(y, m - 1, 1, -4)), end: new Date(Date.UTC(y, m, 1, -4)) });

  await sale("2026-11-05", "4000", "1000.00", "docA", "GP");
  await sale("2026-11-07", "4400", "500.00", "docB", "DENT");
  await sale("2026-11-08", "4900", "50.00"); // no doctor -> "unassigned"
  await sale("2026-10-10", "4000", "400.00", "docA", "GP");
  await postJournal(acc, {
    date: d("2026-11-06"), memo: "rent", idempotencyKey: `s-${k++}`, sourceRef: { type: "fixture", id: "rent" },
    lines: [{ accountId: acct("5100"), debit: "300.00" }, { accountId: acct("1000"), credit: "300.00" }],
  });

  // clinical fixtures for dashboards
  const A = tenantCol<any>(ORG, "appointments");
  const mk = (id: string, status: string, patientId: string, doctorId: string, iso: string) =>
    A.insertOne({ _id: id, patientId, doctorId, branchId: "b1", status, start: d(iso), end: d(iso), type: "consultation", createdAt: d(iso), createdBy: "x", history: [] });
  await mk("a1", "completed", "p1", "docA", "2026-11-05");
  await mk("a2", "completed", "p2", "docA", "2026-11-06");
  await mk("a3", "no_show", "p3", "docB", "2026-11-07");
  await mk("a4", "cancelled", "p4", "docB", "2026-11-08");
  await mk("a5", "completed", "p1", "docA", "2026-10-12");
  const P = tenantCol<any>(ORG, "patients");
  await P.insertOne({ _id: "p1", fullName: "P1", mrn: "M1", createdAt: d("2026-09-01") });
  await P.insertOne({ _id: "p2", fullName: "P2", mrn: "M2", createdAt: d("2026-11-03") });
  await P.insertOne({ _id: "p3", fullName: "P3", mrn: "M3", createdAt: d("2026-11-04") });
  await P.insertOne({ _id: "p4", fullName: "P4", mrn: "M4", createdAt: d("2026-11-05") });
  const base = d("2026-11-05");
  await tenantCol<any>(ORG, "queue_tokens").insertOne({ _id: "t1", doctorId: "docA", branchId: "b1", day: "2026-11-05", number: 1, status: "done", checkedInAt: base, startedAt: new Date(base.getTime() + 12 * 60000), completedAt: new Date(base.getTime() + 30 * 60000) });
  await tenantCol<any>(ORG, "queue_tokens").insertOne({ _id: "t2", doctorId: "docA", branchId: "b1", day: "2026-11-05", number: 2, status: "done", checkedInAt: base, startedAt: new Date(base.getTime() + 8 * 60000), completedAt: new Date(base.getTime() + 20 * 60000) });

  const inv = (id: string, daysAgo: number, balance: string, status = "finalized") =>
    tenantCol<any>(ORG, "invoices").insertOne({ _id: id, number: id, patientId: "p1", status, lines: [], subtotal: toDecimal128(money(balance)), vatTotal: toDecimal128(money(0)), total: toDecimal128(money(balance)), paid: toDecimal128(money(0)), balance: toDecimal128(money(balance)), createdAt: new Date(Date.now() - daysAgo * 86400000), createdBy: "x" });
  await inv("i0", 5, "100.00");
  await inv("i1", 45, "200.00");
  await inv("i2", 75, "300.00");
  await inv("i3", 200, "400.00");
  await inv("i4", 10, "0.00", "paid");
});
afterAll(async () => { await closeClient(); });

describe("pnl / revenue", () => {
  it("P&L from ledger: income 1550, expense 300, net 1250", async () => {
    const r = await pnl(fin, NOV);
    expect(r.income.toFixed(2)).toBe("1550.00");
    expect(r.expense.toFixed(2)).toBe("300.00");
    expect(r.net.toFixed(2)).toBe("1250.00");
  });
  it("revenue by doctor sums to P&L revenue, with an unassigned bucket", async () => {
    const r = await revenueBy(fin, { ...NOV, by: "doctor" });
    expect(r.rows.map((x) => [x.key, x.amount.toFixed(2)])).toEqual(expect.arrayContaining([["docA", "1000.00"], ["docB", "500.00"], ["unassigned", "50.00"]]));
    expect(r.total.toFixed(2)).toBe((await pnl(fin, NOV)).income.toFixed(2));
  });
  it("revenue by department also reconciles", async () => {
    const r = await revenueBy(fin, { ...NOV, by: "department" });
    expect(r.total.toFixed(2)).toBe("1550.00");
  });
  it("empty range returns zeros, never NaN", async () => {
    const r = await pnl(fin, { from: new Date("2020-01-01"), to: new Date("2020-02-01") });
    expect(r.income.toFixed(2)).toBe("0.00");
    expect(r.net.toFixed(2)).toBe("0.00");
    const rb = await revenueBy(fin, { from: new Date("2020-01-01"), to: new Date("2020-02-01"), by: "doctor" });
    expect(rb.rows).toEqual([]);
    expect(rb.total.toFixed(2)).toBe("0.00");
  });
  it("is permission checked", async () => {
    await expect(pnl(ctxFor(["receptionist"], ORG), NOV)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("AR aging", () => {
  it("buckets open balances by age and ignores settled invoices", async () => {
    const r = await arAging(fin, {});
    expect(r.buckets.map((b) => [b.label, b.amount.toFixed(2)])).toEqual([["0-30", "100.00"], ["31-60", "200.00"], ["61-90", "300.00"], ["90+", "400.00"]]);
    expect(r.total.toFixed(2)).toBe("1000.00");
  });
});

describe("dashboards", () => {
  it("executive: KPIs from real data with previous-period comparison", async () => {
    const r = await executiveDashboard(fin, NOV);
    expect(r.current.appointments).toBe(4);
    expect(r.current.noShowRate).toBeCloseTo(0.25);
    expect(r.current.cancellationRate).toBeCloseTo(0.25);
    expect(r.current.newPatients).toBe(3);
    expect(r.current.returningPatients).toBe(1);
    expect(r.current.revenue).toBe("1550.00");
    expect(r.current.outstandingReceivables).toBe("1000.00");
    expect(r.current.avgWaitMinutes).toBeCloseTo(10); // (12 + 8) / 2
    expect(r.previous.revenue).toBe("400.00");
    expect(r.delta.revenue.abs).toBe("1150.00");
  });
  it("executive on an empty period: zero everywhere, no NaN, null pct", async () => {
    const r = await executiveDashboard(fin, { from: new Date("2020-01-01"), to: new Date("2020-02-01") });
    for (const v of Object.values(r.current)) expect(Number.isNaN(v as number)).toBe(false);
    expect(r.current.noShowRate).toBe(0);
    expect(r.delta.revenue.pct).toBeNull();
  });
  it("reception, doctor and accounts dashboards run on the same data", async () => {
    const rec = await receptionDashboard(ctxFor(["receptionist"], ORG), { day: d("2026-11-05") });
    expect(rec.todaysAppointments).toBe(1);
    const dd = await doctorDashboard(ctxFor(["doctor"], ORG, "u-doc"), { doctorId: "docA", day: d("2026-11-05") });
    expect(dd.todaysConsultations).toBe(1);
    const ad = await accountsDashboard(fin, { day: d("2026-11-05") });
    expect(ad.cashCollected).toBe("1000.00");
    expect(ad.outstandingInvoices).toBe(4);
  });
  it("accounts dashboard denies clinical roles", async () => {
    await expect(accountsDashboard(ctxFor(["nurse"], ORG), { day: new Date() })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
