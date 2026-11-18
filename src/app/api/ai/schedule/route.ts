import { apiCtx, respond } from "@/lib/api";
import { cancelSnooze, getSchedule } from "@/modules/ai/brief";

/** GET → settings, pending call-back and the next calls. DELETE → cancel the pending call-back. */
export const GET = () => respond(async () => Response.json(await getSchedule(await apiCtx()), { headers: { "Cache-Control": "no-store" } }));
export const DELETE = () => respond(async () => { await cancelSnooze(await apiCtx()); return Response.json({ ok: true }); });
