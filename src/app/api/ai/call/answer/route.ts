import { apiCtx, respond } from "@/lib/api";
import { canBrief, markCall } from "@/modules/ai/brief";

export const POST = () => respond(async () => {
  const ctx = await apiCtx();
  if (canBrief(ctx)) await markCall(ctx, "answered");
  return Response.json({ ok: true });
});
