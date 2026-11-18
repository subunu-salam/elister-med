import { apiCtx, jsonBody, respond } from "@/lib/api";
import { liveSession } from "@/modules/ai/live";

/** POST {lang?} → a one-use Gemini Live token plus the call's setup (prompt, voice, tools) for the browser to connect with. */
export const POST = (req: Request) => respond(async () => {
  const ctx = await apiCtx();
  const b = await jsonBody<{ lang?: string }>(req).catch(() => ({} as { lang?: string }));
  return Response.json(await liveSession(ctx, b.lang === "ml" ? "ml" : b.lang === "en" ? "en" : undefined), { headers: { "Cache-Control": "no-store" } });
});
