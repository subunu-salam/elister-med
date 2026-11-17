import { describe, expect, it } from "vitest";
import { callsOn, join24, split24, upcomingCalls } from "./schedule-core";

const s = { enabled: true, callTime: "18:00", days: [1, 2, 3, 4, 5, 6], skipDates: ["2026-11-19"] };

describe("call schedule", () => {
  it("rings on chosen weekdays, not on skipped dates or days off", () => {
    expect(callsOn(s, "2026-11-17")).toBe(true);  // Tuesday
    expect(callsOn(s, "2026-11-19")).toBe(false); // skipped
    expect(callsOn(s, "2026-11-22")).toBe(false); // Sunday
  });
  it("lists the next calls, today's first if its time has not passed", () => {
    const next = upcomingCalls(s, new Date("2026-11-17T17:00:00+04:00"), { count: 3 });
    expect(next.map((c) => c.ymd)).toEqual(["2026-11-17", "2026-11-18", "2026-11-20"]);
    expect(next[0].at.toISOString()).toBe("2026-11-17T14:00:00.000Z");
  });
  it("skips today once called, and puts a pending call-back first", () => {
    const next = upcomingCalls(s, new Date("2026-11-17T18:10:00+04:00"), { calledToday: true, snoozeUntil: new Date("2026-11-17T18:40:00+04:00"), count: 2 });
    expect(next.map((c) => c.kind)).toEqual(["callback", "daily"]);
    expect(next[1].ymd).toBe("2026-11-18");
  });
  it("converts between 24-hour time and the hours/minutes picker", () => {
    expect(split24("18:30")).toEqual({ h12: 6, m: 30, pm: true });
    expect(split24("00:05")).toEqual({ h12: 12, m: 5, pm: false });
    expect(join24(6, 30, true)).toBe("18:30");
    expect(join24(12, 0, false)).toBe("00:00");
    expect(join24(12, 15, true)).toBe("12:15");
  });
});
