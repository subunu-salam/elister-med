import { apiCtx, jsonBody, respond } from "@/lib/api";
import { AppError } from "@/core/errors";
import { openDm } from "@/modules/chat/service";

export const POST = (req: Request) => respond(async () => {
  const ctx = await apiCtx();
  const b = await jsonBody<{ userId?: string }>(req);
  if (typeof b.userId !== "string") throw new AppError("VALIDATION", "Pick a colleague");
  return Response.json({ channel: await openDm(ctx, b.userId) });
});
