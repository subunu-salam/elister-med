import { apiCtx, jsonBody, respond } from "@/lib/api";
import { deviceCount, pushConfigured, pushPublicKey, removeSubscription, saveSubscription } from "@/modules/ai/push";

/** GET → public key and whether push is set up; POST {endpoint} → register this device for the assistant's call; DELETE {endpoint}. */
export const GET = () => respond(async () => {
  const ctx = await apiCtx();
  return Response.json({ configured: pushConfigured(), publicKey: pushPublicKey(), devices: await deviceCount(ctx.orgId, ctx.userId) });
});
export const POST = (req: Request) => respond(async () => {
  const ctx = await apiCtx();
  await saveSubscription(ctx, await jsonBody<{ endpoint?: unknown; ua?: unknown }>(req));
  return Response.json({ ok: true, devices: await deviceCount(ctx.orgId, ctx.userId) });
});
export const DELETE = (req: Request) => respond(async () => {
  const ctx = await apiCtx();
  const b = await jsonBody<{ endpoint?: string }>(req);
  if (typeof b.endpoint === "string") await removeSubscription(ctx, b.endpoint);
  return Response.json({ ok: true });
});
