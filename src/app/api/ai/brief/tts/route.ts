import { apiCtx, jsonBody, respond } from "@/lib/api";
import { AppError } from "@/core/errors";
import { canBrief } from "@/modules/ai/brief";
import { synthesize } from "@/modules/ai/voice-provider";

export const maxDuration = 60;

/** POST {text, lang} → audio/wav from the natural voice, or 204 when it is off (the player then uses the browser's voice). */
export const POST = (req: Request) => respond(async () => {
  const ctx = await apiCtx();
  if (!canBrief(ctx)) throw new AppError("FORBIDDEN", "The daily brief is for owners and managers");
  const b = await jsonBody<{ text?: string; lang?: string }>(req);
  if (typeof b.text !== "string" || !b.text.trim()) throw new AppError("VALIDATION", "Nothing to read");
  const wav = await synthesize(b.text, b.lang === "ml" ? "ml" : "en");
  if (!wav) return new Response(null, { status: 204 });
  return new Response(wav as unknown as BodyInit, { headers: { "Content-Type": "audio/wav", "Cache-Control": "private, max-age=86400" } });
});
