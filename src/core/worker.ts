import { getDb } from "./db/client";
import type { OutboxEvent } from "./outbox";

export type Handlers = Record<string, (e: OutboxEvent) => Promise<void>>;
export type WorkerOpts = { maxAttempts?: number; backoffMs?: number; batch?: number };

/** Process due events once. Atomic claim per event so parallel workers never double-deliver. */
export async function runOnce(handlers: Handlers, opts: WorkerOpts = {}): Promise<number> {
  const { maxAttempts = 5, backoffMs = 2000, batch = 20 } = opts;
  const db = await getDb();
  const col = db.collection("outbox");
  const types = Object.keys(handlers);
  let done = 0;
  for (let i = 0; i < batch; i++) {
    const doc = await col.findOneAndUpdate(
      { status: "pending", type: { $in: types }, nextAttemptAt: { $lte: new Date() } },
      { $set: { status: "processing", startedAt: new Date() } },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    );
    if (!doc) break;
    try {
      await handlers[doc.type]({ ...(doc as any), attempts: doc.attempts });
      await col.updateOne({ _id: doc._id }, { $set: { status: "done", doneAt: new Date() } });
    } catch (err) {
      const attempts = doc.attempts + 1;
      const dead = attempts >= maxAttempts;
      await col.updateOne({ _id: doc._id }, {
        $set: {
          status: dead ? "dead" : "pending",
          attempts,
          lastError: String((err as Error)?.message ?? err),
          nextAttemptAt: new Date(Date.now() + backoffMs * 2 ** (attempts - 1)),
        },
      });
    }
    done++;
  }
  return done;
}

export function startWorker(handlers: Handlers, intervalMs = 1000, opts?: WorkerOpts) {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try { await runOnce(handlers, opts); } catch { /* keep alive */ }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  void loop();
  return { stop: () => { stopped = true; } };
}
