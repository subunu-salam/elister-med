import { apiCtx, jsonBody, respond } from "@/lib/api";
import { AppError } from "@/core/errors";
import { askBrief, canBrief } from "@/modules/ai/brief";

/** POST {q, lang} → a spoken answer to a follow-up question, from the brief's figures or the books. */
export const POST = (req: Request) => respond(async () => {
  const ctx = await apiCtx();
  if (!canBrief(ctx)) throw new AppError("FORBIDDEN", "The daily brief is for owners and managers");
  const b = await jsonBody<{ q?: string; lang?: string }>(req);
  if (typeof b.q !== "string" || !b.q.trim()) throw new AppError("VALIDATION", "Ask a question");
  return Response.json(await askBrief(ctx, b.q, b.lang === "ml" ? "ml" : "en"));
});
