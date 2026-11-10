import type { ClientSession } from "mongodb";
import { tenantCol } from "./db";
import { newId } from "./ids";
import type { Ctx } from "./rbac/authorize";

export type Notification = { _id: string; userId: string; type: string; title: string; refType?: string; refId?: string; severity: "info" | "warn" | "critical"; read: boolean; at: Date };

/** In-app notification, written inside the caller's transaction so it exists iff the change committed. */
export async function notifyUser(orgId: string, userId: string | undefined, n: { type: string; title: string; refType?: string; refId?: string; severity?: Notification["severity"] }, s: ClientSession) {
  if (!userId) return;
  await tenantCol<Notification>(orgId, "notifications").insertOne({ _id: newId(), userId, type: n.type, title: n.title, refType: n.refType, refId: n.refId, severity: n.severity ?? "info", read: false, at: new Date() }, s);
}

export async function listMyNotifications(ctx: Ctx, limit = 30): Promise<Notification[]> {
  return tenantCol<Notification>(ctx.orgId, "notifications").find({ userId: ctx.userId } as never, { sort: { at: -1 }, limit });
}
export async function unreadCount(ctx: Ctx): Promise<number> {
  return tenantCol<Notification>(ctx.orgId, "notifications").count({ userId: ctx.userId, read: false } as never);
}
export async function markAllRead(ctx: Ctx): Promise<void> {
  await tenantCol<Notification>(ctx.orgId, "notifications").updateMany({ userId: ctx.userId, read: false } as never, { $set: { read: true } } as never);
}
