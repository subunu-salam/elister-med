import { apiCtx, respond } from "@/lib/api";
import { callNow } from "@/modules/ai/brief";
import { pushConfigured, ringDevices } from "@/modules/ai/push";

export const maxDuration = 60;

/** "Call me now": builds a fresh report and rings this person's devices. devices = 0 tells the page to ring in-app instead. */
export const POST = () => respond(async () => {
  const ctx = await apiCtx();
  const r = await callNow(ctx, ringDevices);
  return Response.json({ devices: r.devices, push: pushConfigured(), preview: r.preview });
});
