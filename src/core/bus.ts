/**
 * In-process realtime bus, keyed by orgId so one tenant can never observe another's events.
 * Single-instance only: a multi-instance deployment must replace publish/subscribe with a shared
 * transport (Mongo change streams on the outbox, or Redis pub/sub). See docs/status.md.
 */
export type BusEvent = { type: string; branchId?: string; payload?: Record<string, unknown> };
type Listener = (e: BusEvent) => void;

type G = { __bus?: Map<string, Set<Listener>> };
const g = globalThis as unknown as G;
const listeners = (g.__bus ??= new Map<string, Set<Listener>>());

export function subscribe(orgId: string, fn: Listener): () => void {
  let set = listeners.get(orgId);
  if (!set) listeners.set(orgId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(orgId);
  };
}

export function publish(orgId: string, e: BusEvent): void {
  for (const fn of listeners.get(orgId) ?? []) {
    try {
      fn(e);
    } catch {
      /* a bad listener must not break publishers */
    }
  }
}
