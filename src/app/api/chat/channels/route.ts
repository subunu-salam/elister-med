import { connection } from "next/server";
import { apiCtx, respond } from "@/lib/api";
import { directory, listChannels } from "@/modules/chat/service";
import { photoVersions } from "@/modules/people/photos";

export const GET = () => respond(async () => {
  await connection();
  const ctx = await apiCtx();
  const [channels, people] = await Promise.all([listChannels(ctx), directory(ctx)]);
  const photos = await photoVersions(ctx.orgId, people.map((p) => p.userId));
  return Response.json({ me: ctx.userId, channels, people: people.map((p) => ({ ...p, photo: photos.get(p.userId) ?? null })) }, { headers: { "Cache-Control": "no-store" } });
});
