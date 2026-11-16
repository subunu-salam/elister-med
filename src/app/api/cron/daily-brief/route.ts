import { publishDailyBriefs } from "@/modules/ai/brief";

export const maxDuration = 300;

/**
 * Called by Vercel Cron every morning (see vercel.json). Vercel sends "Authorization: Bearer $CRON_SECRET"; anything else is refused,
 * and the route does nothing at all unless CRON_SECRET is set.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json(await publishDailyBriefs());
}
