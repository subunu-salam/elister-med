import { apiCtx, respond } from "@/lib/api";
import { canBrief, markListened } from "@/modules/ai/brief";

export const POST = () => respond(async () => {
  const ctx = await apiCtx();
  if (canBrief(ctx)) await markListened(ctx);
  return Response.json({ ok: true });
});
