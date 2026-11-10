/**
 * Simulated clock for the one-year seed. Services stamp records with `new Date()`; by swapping the global Date for a subclass whose "now" is
 * the simulated instant, the REAL services (ledger, invoices, payments, stock...) produce correctly dated, correctly balanced history.
 * Time keeps ticking forward from the chosen instant, so ordering inside a step stays natural. Explicit dates are untouched.
 */
export const RealDate = Date;
let offset = 0;

class SimDate extends RealDate {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(...args: any[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (args.length === 0) super(RealDate.now() + offset); else super(...(args as [any]));
  }
  static now() { return RealDate.now() + offset; }
  static [Symbol.hasInstance](x: unknown) { return x instanceof RealDate; }
}

export function installClock() { (globalThis as { Date: unknown }).Date = SimDate; }
export function uninstallClock() { offset = 0; (globalThis as { Date: unknown }).Date = RealDate; }
export function setNow(d: Date) { offset = d.getTime() - RealDate.now(); }
export function nowMs(): number { return RealDate.now() + offset; }
export function advance(minutes: number) { offset += minutes * 60_000; }
