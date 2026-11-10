import { apiCtx, respond } from "@/lib/api";
import { AppError } from "@/core/errors";
import { getPhoto, removePhoto, savePhoto } from "@/modules/people/photos";

type P = { params: Promise<{ userId: string }> };

export const GET = (_req: Request, { params }: P) => respond(async () => {
  const ctx = await apiCtx();
  if (ctx.roles.includes("patient_portal_user")) throw new AppError("FORBIDDEN", "Staff only");
  const p = await getPhoto(ctx, (await params).userId);
  if (!p) return new Response(null, { status: 404 });
  return new Response(new Uint8Array(p.data), { headers: { "Content-Type": p.contentType, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" } });
});

export const POST = (req: Request, { params }: P) => respond(async () => {
  const ctx = await apiCtx();
  const file = (await req.formData()).get("file");
  if (!(file instanceof File)) throw new AppError("VALIDATION", "Choose a photo");
  await savePhoto(ctx, (await params).userId, Buffer.from(await file.arrayBuffer()));
  return Response.json({ ok: true });
});

export const DELETE = (_req: Request, { params }: P) => respond(async () => {
  const ctx = await apiCtx();
  await removePhoto(ctx, (await params).userId);
  return Response.json({ ok: true });
});
