import { describe, expect, it } from "vitest";
import { allowedSections, answerFromFacts, attention, composeBrief, detectIntent, money, shareText, type BriefFacts } from "./brief-core";

const facts = (o: Partial<BriefFacts> = {}): BriefFacts => ({
  ymd: "2026-11-16", dow: 1, period: "today", hour: 20, recipient: "Dr. Salam Khan (Owner)", org: "Elister Med",
  scope: { clinical: true, finance: true },
  day: { appts: 42, seen: 36, newPatients: 5, noShows: 5, cancelled: 1, revenue: 18450, revenuePrev: 16200, revenueLastWeek: 27000 },
  mtd: { revenue: 245000, revenuePrev: 210000, netProfit: 61200, appts: 540, topDoctor: { name: "Dr. Anjali Menon", amount: 58200 } },
  ar: { patient: 84200, over30: 31000, over90: 12400, trade: 150000, tradeOverdue: 60000, chase: [{ name: "Daman Insurance", amount: 42000, days: 47 }] },
  next: { when: "tomorrow", dow: 2, booked: 22, expected: 40, firstAt: "09:00", busiest: { name: "Dr. Anjali Menon", count: 9 }, after: 17 },
  cash: { balance: 1250000, score: 72, grade: "Healthy", runwayMonths: null, breachWeek: null, lowest: 900000, anomalies: 0, duplicates: 1, duplicateAmount: 3150 },
  ...o,
});

describe("money", () => {
  it("speaks English in thousands/millions and Malayalam in lakh/crore", () => {
    expect(money(18450, "en")).toBe("18,450 dirhams");
    expect(money(2_500_000, "en")).toBe("2.5 million dirhams");
    expect(money(245000, "ml")).toBe("2.45 ലക്ഷം ദിർഹം");
    expect(money(25_000_000, "ml")).toBe("2.5 കോടി ദിർഹം");
  });
});

describe("composeBrief", () => {
  it("greets by first name without the title and covers every chapter", () => {
    const b = composeBrief(facts(), "en");
    expect(b.sections[0].text).toContain("Good evening, Salam.");
    expect(b.sections.map((s) => s.key)).toEqual(["intro", "patients", "revenue", "receivables", "upcoming", "cash", "attention", "close"]);
    expect(b.sections.at(-1)!.text).toContain("anything else");
    expect(b.seconds).toBeGreaterThan(60);
    expect(b.seconds).toBeLessThanOrEqual(200);
  });
  it("keeps only the chapters the owner chose", () => {
    expect(composeBrief(facts(), "en", { sections: ["revenue"] }).sections.map((s) => s.key)).toEqual(["intro", "revenue", "close"]);
  });
  it("drops money chapters for someone without finance access", () => {
    expect(allowedSections({ scope: { clinical: true, finance: false }, cash: undefined })).toEqual(["patients", "upcoming", "attention"]);
    expect(answerFromFacts("what was revenue", facts({ scope: { clinical: true, finance: false }, cash: undefined }), "en").answer).toContain("super admin");
  });
  it("says yesterday for a morning report", () => {
    expect(composeBrief(facts({ period: "yesterday", hour: 8 }), "en").text).toContain("Yesterday the clinic saw");
  });
  it("leaves out the cash chapter for users who cannot see the books", () => {
    expect(composeBrief(facts({ cash: undefined }), "en").sections.some((s) => s.key === "cash")).toBe(false);
  });
  it("writes the Malayalam brief in Malayalam script", () => {
    const b = composeBrief(facts(), "ml");
    expect(b.text).toMatch(/[ഀ-ൿ]/);
    expect(b.sections.find((s) => s.key === "revenue")!.text).toContain("ലക്ഷം");
  });
  it("never invents a comparison when there is no prior figure", () => {
    const b = composeBrief(facts({ day: { ...facts().day, revenuePrev: null, revenueLastWeek: 0 } }), "en");
    expect(b.sections.find((s) => s.key === "revenue")!.text).not.toMatch(/day before|last week/);
  });
});

describe("attention", () => {
  it("orders critical items first and flags old receivables, a revenue drop and duplicates", () => {
    const a = attention(facts(), "en");
    expect(a[0].level).toBe("critical");
    expect(a.map((x) => x.key)).toEqual(expect.arrayContaining(["ar_90", "rev_drop", "duplicates", "quiet_day", "mtd_up"]));
  });
  it("puts a cash breach at the top", () => {
    expect(attention(facts({ cash: { ...facts().cash!, breachWeek: 5 } }), "en")[0].key).toBe("cash_breach");
  });
});

describe("follow-up questions", () => {
  it("recognises English and Malayalam questions", () => {
    expect(detectIntent("Who owes us the most?")).toBe("receivables");
    expect(detectIntent("ആരിൽ നിന്നാണ് പണം കിട്ടാനുള്ളത്?")).toBe("receivables");
    expect(detectIntent("How long will our cash last?")).toBe("cash");
    expect(detectIntent("what about last month")).toBe("month");
    expect(detectIntent("ഇന്നലത്തെ വരുമാനം എത്ര?")).toBe("revenue");
  });
  it("answers a Malayalam question in Malayalam even when the setting is English", () => {
    const a = answerFromFacts("ഇന്നലത്തെ വരുമാനം എത്ര?", facts(), "en");
    expect(a.handled).toBe(true);
    expect(a.answer).toMatch(/[ഀ-ൿ]/);
  });
  it("switches language on request", () => {
    expect(answerFromFacts("speak in Malayalam", facts(), "en").switchLang).toBe("ml");
  });
  it("ends the call when the owner says they are done", () => {
    expect(answerFromFacts("no thanks", facts(), "en").end).toBe(true);
    expect(answerFromFacts("ഇല്ല", facts(), "en").end).toBe(true);
  });
  it("sends spending questions to the books", () => {
    expect(detectIntent("how much did we spend on rent last month")).toBe("unknown");
  });
  it("hands unknown questions back to the server", () => {
    expect(answerFromFacts("how much did we spend on rent", facts(), "en").handled).toBe(false);
  });
});

it("builds a WhatsApp summary with KPIs and issues", () => {
  const t = shareText(composeBrief(facts(), "en"));
  expect(t).toContain("Revenue today: AED 18.4K");
  expect(t).toContain("⚠");
});
