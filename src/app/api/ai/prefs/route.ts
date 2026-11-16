import { apiCtx, jsonBody, respond } from "@/lib/api";
import { assertBrief, getPrefs, savePrefs, type AssistantPrefs } from "@/modules/ai/brief";

export const GET = () => respond(async () => {
  const ctx = await apiCtx();
  assertBrief(ctx);
  return Response.json(await getPrefs(ctx.orgId, ctx.userId));
});
export const POST = (req: Request) => respond(async () => {
  const ctx = await apiCtx();
  return Response.json(await savePrefs(ctx, await jsonBody<Partial<AssistantPrefs>>(req)));
});
