import { apiCtx, respond } from "@/lib/api";
import { assertBrief, callPreview } from "@/modules/ai/brief";

/** Asked by the service worker when a push arrives: what should the ringing notification say. */
export const GET = () => respond(async () => {
  const ctx = await apiCtx();
  assertBrief(ctx);
  return Response.json(await callPreview(ctx), { headers: { "Cache-Control": "no-store" } });
});
