import Decimal from "decimal.js";
import { Decimal128 } from "mongodb";

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type Money = Decimal;

export function money(v: string | number | Decimal): Decimal {
  return new Decimal(v);
}
export function toDecimal128(d: Decimal): Decimal128 {
  return Decimal128.fromString(d.toFixed());
}
export function fromDecimal128(x: Decimal128 | string | number | undefined | null): Decimal {
  if (x === undefined || x === null) return new Decimal(0);
  return new Decimal(typeof x === "object" ? x.toString() : x);
}
export function sum(ds: Decimal[]): Decimal {
  return ds.reduce((a, b) => a.plus(b), new Decimal(0));
}
export function round2(d: Decimal): Decimal {
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}
