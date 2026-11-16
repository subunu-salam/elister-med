import { apiCtx, respond } from "@/lib/api";
import { AppError } from "@/core/errors";
import { briefHistory, canBrief, getBrief } from "@/modules/ai/brief";

/** GET /api/ai/brief?lang=en|ml[&refresh=1] → today's brief, composed from the stored morning snapshot. */
export const GET = (req: Request) => respond(async () => {
  const ctx = await apiCtx();
  if (!canBrief(ctx)) throw new AppError("FORBIDDEN", "The daily brief is for owners and managers");
  const u = new URL(req.url);
  const lang = u.searchParams.get("lang") === "ml" ? "ml" : "en";
  const [brief, history] = await Promise.all([getBrief(ctx, lang, { refresh: u.searchParams.get("refresh") === "1" }), briefHistory(ctx)]);
  return Response.json({ brief, history }, { headers: { "Cache-Control": "no-store" } });
});
