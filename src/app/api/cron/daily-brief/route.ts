import { placeDueCalls } from "@/modules/ai/brief";
import { ringDevices } from "@/modules/ai/push";

export const maxDuration = 300;

/**
 * Called by Vercel Cron (see vercel.json; daily at 20:00 Dubai on the Hobby plan): rings everyone whose call time has passed today and who has not been called yet.
 * Vercel sends "Authorization: Bearer $CRON_SECRET"; anything else is refused, and nothing runs unless CRON_SECRET is set.
 * For exact per-person times, run it hourly: change the schedule to "0 * * * *" on Vercel Pro, or call this URL hourly from any scheduler.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json(await placeDueCalls(new Date(), ringDevices));
}
