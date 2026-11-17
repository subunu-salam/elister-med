import { apiCtx, jsonBody, respond } from "@/lib/api";
import { snoozeCall } from "@/modules/ai/brief";

/** POST {minutes?} → "call me back later": the scheduler rings this person again after that many minutes (default 30). */
export const POST = (req: Request) => respond(async () => {
  const ctx = await apiCtx();
  const b = await jsonBody<{ minutes?: number }>(req).catch(() => ({} as { minutes?: number }));
  const until = await snoozeCall(ctx, typeof b.minutes === "number" ? b.minutes : 30);
  return Response.json({ until: until.toISOString() });
});
