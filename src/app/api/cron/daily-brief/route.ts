import { placeDueCalls } from "@/modules/ai/brief";
import { ringDevices } from "@/modules/ai/push";

export const maxDuration = 300;

/**
 * Called by Vercel Cron every hour (see vercel.json): rings everyone whose assistant call time falls in this Dubai hour.
 * Vercel sends "Authorization: Bearer $CRON_SECRET"; anything else is refused, and nothing runs unless CRON_SECRET is set.
 * Note: Vercel's Hobby plan runs crons once a day only; hourly needs Pro (or call this URL hourly from any scheduler).
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json(await placeDueCalls(new Date(), ringDevices));
}
