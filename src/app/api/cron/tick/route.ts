import { tick } from "@/modules/ai/scheduler";

export const maxDuration = 120;

/**
 * Public, harmless "wake up and check": rings only calls that are already due (each at most once) and runs at most every 30 seconds.
 * Pinged by the GitHub Actions job every 5 minutes, which also keeps a free Render instance from sleeping.
 */
export async function GET() {
  const r = await tick();
  return Response.json({ ok: true, ...r }, { headers: { "Cache-Control": "no-store" } });
}
