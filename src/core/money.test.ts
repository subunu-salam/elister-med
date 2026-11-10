import { describe, it, expect } from "vitest";
import { Decimal128 } from "mongodb";
import { money, toDecimal128, fromDecimal128, sum, round2 } from "./money";
import { dubaiDayRange } from "./time";
import { AppError } from "./errors";
import { newId } from "./ids";

describe("money", () => {
  it("0.1 + 0.2 equals 0.3 exactly", () => {
    expect(money("0.1").plus(money("0.2")).equals("0.3")).toBe(true);
  });
  it("round trips Decimal128", () => {
    const d = fromDecimal128(toDecimal128(money("1234.56")));
    expect(d.toFixed(2)).toBe("1234.56");
    expect(toDecimal128(money("1")) instanceof Decimal128).toBe(true);
  });
  it("sums and rounds half up to 2dp", () => {
    expect(sum([money("0.1"), money("0.2"), money("0.3")]).toFixed(2)).toBe("0.60");
    expect(round2(money("2.005")).toFixed(2)).toBe("2.01");
    expect(sum([]).toFixed(2)).toBe("0.00");
  });
});

describe("dubaiDayRange", () => {
  it("is UTC+4 aligned", () => {
    const { start, end } = dubaiDayRange(new Date("2026-11-03T21:00:00Z")); // 01:00 on 4th Dubai
    expect(start.toISOString()).toBe("2026-11-03T20:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-04T20:00:00.000Z");
  });
});

describe("errors/ids", () => {
  it("AppError carries code and status", () => {
    const e = new AppError("CONFLICT", "x");
    expect(e.status).toBe(409);
    expect(e.code).toBe("CONFLICT");
  });
  it("newId is 24 hex", () => {
    expect(newId()).toMatch(/^[0-9a-f]{24}$/);
  });
});
