import { apiCtx, jsonBody, respond } from "@/lib/api";
import { AppError } from "@/core/errors";
import { getMessages, sendMessage } from "@/modules/chat/service";

export const GET = (req: Request) => respond(async () => {
  const ctx = await apiCtx();
  const u = new URL(req.url);
  const c = u.searchParams.get("c");
  if (!c) throw new AppError("VALIDATION", "Missing conversation");
  const after = u.searchParams.get("after");
  const at = after ? new Date(after) : undefined;
  if (at && Number.isNaN(+at)) throw new AppError("VALIDATION", "Bad time");
  return Response.json({ messages: await getMessages(ctx, c, { after: at }) }, { headers: { "Cache-Control": "no-store" } });
});

export const POST = (req: Request) => respond(async () => {
  const ctx = await apiCtx();
  const b = await jsonBody<{ c?: string; body?: string }>(req);
  if (typeof b.c !== "string" || typeof b.body !== "string") throw new AppError("VALIDATION", "Missing message");
  return Response.json({ message: await sendMessage(ctx, b.c, b.body, ctx.name) });
});
