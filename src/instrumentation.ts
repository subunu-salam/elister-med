/**
 * Runs once when the server starts. On a long-running server (Render, a VM) it checks every minute for personal-assistant calls
 * that are due (daily call times and "call me back" requests) and rings them, so calls arrive on the minute without any external cron.
 * Off on serverless hosts (Vercel), where the cron route is used instead. Set ELISTER_SCHEDULER=0 to turn it off, =1 to force it on.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const on = process.env.ELISTER_SCHEDULER === "1" || (process.env.ELISTER_SCHEDULER !== "0" && !process.env.VERCEL && !!process.env.MONGODB_URI);
  if (!on) return;
  const { startCallScheduler } = await import("./modules/ai/scheduler");
  startCallScheduler();
}
