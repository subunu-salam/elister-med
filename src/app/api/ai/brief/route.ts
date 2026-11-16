import { apiCtx, respond } from "@/lib/api";
import { assertBrief, briefHistory, getBrief } from "@/modules/ai/brief";

/** GET /api/ai/brief?lang=en|ml[&refresh=1] → the current report, composed from the stored snapshot with the person's chosen sections. */
export const GET = (req: Request) => respond(async () => {
  const ctx = await apiCtx();
  assertBrief(ctx);
  const u = new URL(req.url);
  const l = u.searchParams.get("lang");
  const [brief, history] = await Promise.all([getBrief(ctx, l === "ml" ? "ml" : l === "en" ? "en" : undefined, { refresh: u.searchParams.get("refresh") === "1" }), briefHistory(ctx)]);
  return Response.json({ brief, history }, { headers: { "Cache-Control": "no-store" } });
});
