import { Binary } from "mongodb";
import { tenantCol } from "@/core/db";
import { AppError } from "@/core/errors";
import type { Ctx } from "@/core/rbac/authorize";

/** Profile photos live in the database, keyed by user, and are only served to signed-in staff of the same organisation. */
type Photo = { _id: string; userId: string; contentType: string; data: Binary; size: number; at: Date };
const col = (o: string) => tenantCol<Photo>(o, "profile_photos");

export const MAX_PHOTO_BYTES = 400_000;
type ImageType = "image/jpeg" | "image/png" | "image/webp";

function sniff(b: Buffer): ImageType | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** A person may change their own photo. HR (hr:update) may set anyone's, for example a doctor who has no time to do it. */
export async function savePhoto(ctx: Ctx, userId: string, data: Buffer): Promise<void> {
  if (ctx.userId !== userId && !ctx.permissions.includes("hr:update")) throw new AppError("FORBIDDEN", "You can only change your own photo");
  if (data.length > MAX_PHOTO_BYTES) throw new AppError("VALIDATION", "That photo is too large. Pick one under 400 KB.");
  const contentType = sniff(data);
  if (!contentType) throw new AppError("VALIDATION", "Use a JPEG, PNG or WebP image");
  const m = await tenantCol<{ userId: string }>(ctx.orgId, "memberships").findOne({ userId, active: true } as never);
  const s = m ?? (await tenantCol<{ _id: string }>(ctx.orgId, "staff").findOne({ _id: userId } as never));
  if (!s) throw new AppError("NOT_FOUND", "That person is not on the staff list");
  await col(ctx.orgId).updateOne({ userId } as never, { $set: { userId, contentType, data: new Binary(data), size: data.length, at: new Date() }, $setOnInsert: { _id: `${ctx.orgId}:${userId}` } } as never, undefined, { upsert: true });
}

export async function removePhoto(ctx: Ctx, userId: string): Promise<void> {
  if (ctx.userId !== userId && !ctx.permissions.includes("hr:update")) throw new AppError("FORBIDDEN", "You can only change your own photo");
  await col(ctx.orgId).deleteMany({ userId } as never);
}

export async function getPhoto(ctx: Ctx, userId: string): Promise<{ data: Buffer; contentType: string; at: Date } | null> {
  const p = await col(ctx.orgId).findOne({ userId } as never);
  return p ? { data: Buffer.from(p.data.buffer), contentType: p.contentType, at: p.at } : null;
}

/** Cache-busting version (upload time in ms) for each user who has a photo. Users without one are absent from the map. */
export async function photoVersions(orgId: string, userIds: (string | undefined)[]): Promise<Map<string, number>> {
  const ids = [...new Set(userIds.filter(Boolean) as string[])];
  if (!ids.length) return new Map();
  const rows = await tenantCol<Photo>(orgId, "profile_photos").find({ userId: { $in: ids } } as never, { projection: { userId: 1, at: 1 } });
  return new Map(rows.map((r) => [r.userId, +r.at]));
}
