import { describe, expect, it } from "vitest";
import { allowedSections, answerFromFacts, callOpening, parseCallback, parseOpeningReply, attention, composeBrief, detectIntent, money, shareText, type BriefFacts } from "./brief-core";

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
    expect(b.sections.at(-1)!.text).toContain("anything you'd like to ask");
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

describe("the call opening", () => {
  it("greets the owner by first name and offers to call back", () => {
    const t = callOpening(facts({ recipient: "Salim" }), "en");
    expect(t).toContain("Hi Salim, how are you doing?");
    expect(t).toContain("call you back in 30 minutes");
    expect(callOpening(facts({ recipient: "Salim" }), "ml")).toContain("സുഖമാണോ");
  });
  it("understands carry on and call back, in English and Malayalam", () => {
    expect(parseOpeningReply("I'm good, go ahead")).toBe("continue");
    expect(parseOpeningReply("yes please carry on")).toBe("continue");
    expect(parseOpeningReply("I'm busy, call me back later")).toBe("later");
    expect(parseOpeningReply("call me in 30 minutes")).toBe("later");
    expect(parseOpeningReply("ശരി, പറയൂ")).toBe("continue");
    expect(parseOpeningReply("പിന്നെ വിളിക്കൂ")).toBe("later");
    expect(parseOpeningReply("hmm")).toBe("unclear");
  });
  it("closes the report by name and invites questions", () => {
    expect(composeBrief(facts({ recipient: "Salim" }), "en").sections.at(-1)!.text).toBe("That's the full picture, Salim. Is there anything you'd like to ask me?");
  });
  it("answers how the week went", () => {
    const a = answerFromFacts("how was this week?", facts({ week: { visits: 96, prevVisits: 80, revenue: 52000, prevRevenue: 47000, newPatients: 14, busiest: { ymd: "2026-11-16", dow: 1, visits: 21 } } }), "en");
    expect(a.answer).toContain("96 patients");
    expect(a.answer).toContain("Monday");
  });
});

describe("call me back", () => {
  const now = new Date("2026-11-18T12:36:00+04:00"); // 12:36 Dubai
  it("understands times and durations (Dubai time)", () => {
    expect(parseCallback("I said just give me a call back at 12:37", now)).toBe(1);
    expect(parseCallback("call me back at 5 pm", now)).toBe(4 * 60 + 24);
    expect(parseCallback("call me at 5", now)).toBe(4 * 60 + 24);
    expect(parseCallback("call me back in 10 minutes", now)).toBe(10);
    expect(parseCallback("ring me in an hour", now)).toBe(60);
    expect(parseCallback("call me back in half an hour", now)).toBe(30);
    expect(parseCallback("call me back later", now)).toBe(30);
    expect(parseCallback("call me back at 9", now)).toBe(8 * 60 + 24); // next 9 o'clock is 9 pm
    expect(parseCallback("who owes us the most?", now)).toBe(null);
  });
  it("books the call-back from anywhere in the conversation and ends the call", () => {
    const a = answerFromFacts("give me a call back at 12:37", facts({ recipient: "Salim" }), "en", now);
    expect(a.intent).toBe("callback");
    expect(a.callbackMinutes).toBe(1);
    expect(a.end).toBe(true);
    expect(a.answer).toContain("Sure, Salim. I'll call you back at 12:37 pm");
  });
  it("treats a time at the opening question as call me later", () => {
    expect(parseOpeningReply("call me at 5 pm")).toBe("later");
  });
});

describe("voice reschedule of the daily call", () => {
  it("reads the new regular time", async () => {
    const { parseDailyTime } = await import("./brief-core");
    expect(parseDailyTime("Call me every day at 7 pm")).toBe("19:00");
    expect(parseDailyTime("move my daily call to 19:30")).toBe("19:30");
    expect(parseDailyTime("from now on call me at 8:15 am")).toBe("08:15");
    expect(parseDailyTime("reschedule my report to 6")).toBe("18:00");
    expect(parseDailyTime("call me back in 30 minutes")).toBeNull();
    expect(parseDailyTime("call me back at 5 pm")).toBeNull();
  });
  it("routes daily vs one-off requests to the right intent", async () => {
    const { detectIntent } = await import("./brief-core");
    expect(detectIntent("call me every day at 7 pm")).toBe("reschedule");
    expect(detectIntent("change my call time")).toBe("reschedule");
    expect(detectIntent("call me back in 10 minutes")).toBe("callback");
    expect(detectIntent("how many new patients today")).toBe("newpatients");
    expect(detectIntent("how many cancellations")).toBe("cancelled");
    expect(detectIntent("what is overdue more than 90 days")).toBe("overdue");
    expect(detectIntent("when is the first appointment")).toBe("first_appt");
  });
});
