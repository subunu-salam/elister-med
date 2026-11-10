import { describe, expect, it } from "vitest";
import { closeReadiness, collectionProbability, detectAnomalies, findDuplicates, forecastCash, healthScore, parseIntent, parsePeriod, prioritizeCollections, suggestCategory } from "./insights-core";

const T = new Date("2026-11-10T08:00:00Z");
const d = (s: string) => new Date(`${s}T08:00:00Z`);

describe("health score", () => {
  it("rewards liquidity, profit and on-time collections", () => {
    const h = healthScore({ cash: 400000, receivables: 100000, payables: 100000, vatPayable: 10000, income: 1000000, expense: 700000, monthlyNetCash: 20000, overdueShare: 0.05 });
    expect(h.score).toBeGreaterThanOrEqual(80);
    expect(h.runwayMonths).toBeNull();
  });
  it("flags a burning, unprofitable business", () => {
    const h = healthScore({ cash: 30000, receivables: 20000, payables: 120000, vatPayable: 5000, income: 200000, expense: 260000, monthlyNetCash: -15000, overdueShare: 0.6 });
    expect(h.grade).toBe("At risk");
    expect(h.runwayMonths).toBe(2);
  });
});

describe("cash forecast", () => {
  it("weights receivables and subtracts bills", () => {
    const f = forecastCash({ today: T, openingCash: 10000, monthlyNet: [0, 0, 0], receivables: [{ due: d("2026-11-12"), amount: 1000, daysOverdue: 0 }], payables: [{ due: d("2026-11-20"), amount: 500 }] });
    expect(f.points).toHaveLength(13);
    expect(f.points[0].inflow).toBe(900);
    expect(f.points[1].outflow).toBe(500);
    expect(f.points[12].expected).toBe(10400);
  });
  it("finds the week cash goes below the buffer", () => {
    const f = forecastCash({ today: T, openingCash: 1000, monthlyNet: [-8690, -8690], receivables: [], payables: [] });
    expect(f.breachWeek).toBe(2);
  });
  it("collection probability falls with lateness", () => { expect(collectionProbability(0)).toBeGreaterThan(collectionProbability(100)); });
});

describe("anomalies and duplicates", () => {
  it("spots an outlier and a monthly spike", () => {
    const base = [1, 2, 3, 4, 5, 6].map((i) => ({ id: `h${i}`, date: d(`2026-${String(i + 4).padStart(2, "0")}-15`), accountCode: "5700", accountName: "Marketing", amount: 1000 + i * 10, memo: "Ads" }));
    const hits = detectAnomalies([...base, { id: "x", date: d("2026-11-05"), accountCode: "5700", accountName: "Marketing", amount: 9000, memo: "Billboard" }], T);
    expect(hits.some((h) => h.kind === "outlier" && h.id === "o:x")).toBe(true);
    expect(hits.some((h) => h.kind === "spike")).toBe(true);
  });
  it("matches same vendor + amount within a week, ignoring legal suffixes", () => {
    const p = findDuplicates([
      { id: "a", source: "expense", vendor: "Al Noor Trading LLC", amount: 1250, date: d("2026-11-01") },
      { id: "b", source: "bill", vendor: "al noor", amount: 1250, date: d("2026-11-04") },
      { id: "c", source: "bill", vendor: "al noor", amount: 1250, date: d("2026-12-30") },
    ]);
    expect(p).toHaveLength(1);
  });
});

describe("collections", () => {
  it("puts the oldest large balance first with a final notice", () => {
    const r = prioritizeCollections([
      { id: "1", number: "INV-1", customer: "A", balance: 5000, daysOverdue: 5 },
      { id: "2", number: "INV-2", customer: "B", balance: 5000, daysOverdue: 95 },
    ]);
    expect(r[0].id).toBe("2");
    expect(r[0].stage).toBe("Final notice");
  });
});

describe("categorisation and questions", () => {
  it("learns from history then falls back to keywords", () => {
    expect(suggestCategory("Monthly Google ads", [])?.code).toBe("5700");
    expect(suggestCategory("Gulf Cleaning monthly", [{ text: "Gulf Cleaning monthly contract", code: "5800" }])?.code).toBe("5800");
  });
  it("parses intents and periods", () => {
    expect(parseIntent("How much did we spend on rent last quarter?")).toEqual({ kind: "spend", term: "rent" });
    expect(parseIntent("who owes us money").kind).toBe("receivables");
    expect(parsePeriod("profit last month", T).label).toBe("last month");
    expect(parsePeriod("revenue in march 2026", T).label).toBe("March 2026");
    expect(parsePeriod("cash", T).label).toBe("this month");
  });
  it("scores month-end readiness", () => {
    expect(closeReadiness({ unmatchedBank: 0, draftJournals: 0, draftInvoices: 0, billsAwaitingApproval: 0, dueRecurring: 0, trialBalanced: true, openPriorPeriods: 0 }).pct).toBe(100);
  });
});
