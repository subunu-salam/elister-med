import "server-only";
import { placeDueCalls } from "./brief";
import { ringDevices } from "./push";

/**
 * In-process scheduler for the assistant's calls (see src/instrumentation.ts). One tick a minute; a tick never overlaps the previous one.
 * tick() is also called by /api/cron/tick, which an external pinger (the GitHub Actions job) hits every few minutes: on Render's free
 * plan that keeps the server awake and catches anything a sleeping server missed. placeDueCalls rings each call at most once.
 */
let running = false;
let lastRun = 0;
let timer: ReturnType<typeof setInterval> | undefined;

export async function tick(minGapMs = 30_000): Promise<{ called: number; failed: number; skipped?: boolean }> {
  if (running || Date.now() - lastRun < minGapMs) return { called: 0, failed: 0, skipped: true };
  running = true; lastRun = Date.now();
  try { return await placeDueCalls(new Date(), ringDevices); }
  catch (e) { console.error("call scheduler tick failed", e); return { called: 0, failed: 1 }; }
  finally { running = false; }
}

export function startCallScheduler() {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, 60_000);
  setTimeout(() => { void tick(); }, 15_000); // first check soon after start-up
  console.log("assistant call scheduler: checking every minute");
}
