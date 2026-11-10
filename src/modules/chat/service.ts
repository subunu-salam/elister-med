import { tenantCol } from "@/core/db";
import { userNames } from "@/core/auth";
import { AppError } from "@/core/errors";
import { newId } from "@/core/ids";
import type { Ctx } from "@/core/rbac/authorize";

/**
 * Staff chat. Group channels are open to every staff member or limited to roles; direct messages exist only between their two members.
 * Patients (portal users) can never read or write here. Messages are plain text and are never edited or sent outside the organisation.
 */
export type ChatChannel = { _id: string; kind: "channel" | "dm"; key?: string; name: string; description?: string; roles?: string[]; members?: string[] };
export type ChatMessage = { _id: string; channelId: string; userId: string; name: string; body: string; at: Date };

const channels = (o: string) => tenantCol<ChatChannel>(o, "chat_channels");
const messages = (o: string) => tenantCol<ChatMessage>(o, "chat_messages");
const reads = (o: string) => tenantCol<{ _id: string; userId: string; channelId: string; at: Date }>(o, "chat_reads");

export const MAX_BODY = 2000;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 8;

const GROUPS: Omit<ChatChannel, "_id" | "kind">[] = [
  { key: "general", name: "General", description: "Everyone at the clinic" },
  { key: "clinical", name: "Clinical team", description: "Doctors, nurses, lab, radiology and pharmacy", roles: ["doctor", "nurse", "medical_director", "clinic_manager", "radiologist", "lab_technician", "pharmacist"] },
  { key: "front-desk", name: "Front desk", description: "Reception, queue and bookings", roles: ["receptionist", "nurse", "clinic_manager", "insurance_coordinator"] },
  { key: "finance", name: "Finance and insurance", description: "Billing, claims and the books", roles: ["accountant", "finance_manager", "insurance_coordinator", "medical_coder", "clinic_manager"] },
];

function assertStaff(ctx: Ctx) {
  if (ctx.roles.includes("patient_portal_user") || ctx.patientId) throw new AppError("FORBIDDEN", "Staff chat is for clinic staff only");
}
const broad = (ctx: Ctx) => ctx.roles.includes("org_admin") || ctx.roles.includes("platform_super_admin");
const canSee = (ctx: Ctx, c: ChatChannel) =>
  c.kind === "dm" ? !!c.members?.includes(ctx.userId) : !c.roles || broad(ctx) || c.roles.some((r) => (ctx.roles as string[]).includes(r));
export const dmId = (orgId: string, a: string, b: string) => `${orgId}:dm:${[a, b].sort().join(":")}`;

const ready = new Set<string>();
async function ensureChannels(orgId: string) {
  if (ready.has(orgId)) return;
  for (const g of GROUPS)
    await channels(orgId).updateOne({ key: g.key, kind: "channel" } as never, { $set: { ...g, kind: "channel" }, $setOnInsert: { _id: `${orgId}:ch:${g.key}` } } as never, undefined, { upsert: true });
  ready.add(orgId);
}

async function channelFor(ctx: Ctx, id: string): Promise<ChatChannel> {
  assertStaff(ctx);
  await ensureChannels(ctx.orgId);
  const c = await channels(ctx.orgId).findOne({ _id: id } as never);
  if (!c || !canSee(ctx, c)) throw new AppError("NOT_FOUND", "Conversation not found");
  return c;
}

export type StaffPerson = { userId: string; name: string; roles: string[]; specialty?: string };
/** Everyone in the organisation who can use chat, with display names from the user records. */
export async function directory(ctx: Ctx): Promise<StaffPerson[]> {
  assertStaff(ctx);
  const ms = await tenantCol<{ userId: string; roles: string[]; active: boolean }>(ctx.orgId, "memberships").find({ active: true } as never);
  const staff = ms.filter((m) => !m.roles.includes("patient_portal_user"));
  const names = await userNames(staff.map((m) => m.userId));
  const docs = await tenantCol<{ userId?: string; specialty?: string }>(ctx.orgId, "staff").find({ role: "doctor" } as never);
  const spec = new Map(docs.filter((d) => d.userId).map((d) => [d.userId!, d.specialty]));
  return staff.map((m) => ({ userId: m.userId, name: names.get(m.userId)?.replace(/\s*\(.*?\)\s*/g, "").trim() || "Staff", roles: m.roles, specialty: spec.get(m.userId) })).sort((a, b) => a.name.localeCompare(b.name));
}

export type ChannelRow = ChatChannel & { unread: number; last?: { body: string; at: Date; name: string } };
/** The conversations this person can see, newest activity first within each kind, with unread counts. */
export async function listChannels(ctx: Ctx): Promise<ChannelRow[]> {
  assertStaff(ctx);
  await ensureChannels(ctx.orgId);
  const all = (await channels(ctx.orgId).find({} as never)).filter((c) => canSee(ctx, c));
  const seen = new Map((await reads(ctx.orgId).find({ userId: ctx.userId } as never)).map((r) => [r.channelId, r.at]));
  const out: ChannelRow[] = [];
  for (const c of all) {
    const last = (await messages(ctx.orgId).find({ channelId: c._id } as never, { sort: { at: -1 }, limit: 1 }))[0];
    const since = seen.get(c._id);
    const unread = await messages(ctx.orgId).count({ channelId: c._id, userId: { $ne: ctx.userId }, ...(since ? { at: { $gt: since } } : {}) } as never);
    out.push({ ...c, unread, last: last ? { body: last.body, at: last.at, name: last.name } : undefined });
  }
  const rank = (c: ChannelRow) => (c.kind === "channel" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || +(b.last?.at ?? 0) - +(a.last?.at ?? 0) || a.name.localeCompare(b.name));
}

export async function unreadTotal(ctx: Ctx): Promise<number> {
  if (ctx.roles.includes("patient_portal_user")) return 0;
  return (await listChannels(ctx)).reduce((a, c) => a + c.unread, 0);
}

/** Opens (creating if needed) the direct conversation with another staff member. */
export async function openDm(ctx: Ctx, otherUserId: string): Promise<ChatChannel> {
  assertStaff(ctx);
  if (otherUserId === ctx.userId) throw new AppError("VALIDATION", "Pick a colleague to message");
  const person = (await directory(ctx)).find((p) => p.userId === otherUserId);
  if (!person) throw new AppError("NOT_FOUND", "That person is not on the staff list");
  const me = (await directory(ctx)).find((p) => p.userId === ctx.userId);
  const _id = dmId(ctx.orgId, ctx.userId, otherUserId);
  await channels(ctx.orgId).updateOne({ _id } as never, { $setOnInsert: { _id, kind: "dm", name: `${me?.name ?? "Staff"} and ${person.name}`, members: [ctx.userId, otherUserId] } } as never, undefined, { upsert: true });
  return (await channels(ctx.orgId).findOne({ _id } as never))!;
}

/** Messages in order. With `after`, only newer ones. Reading marks the conversation as read. */
export async function getMessages(ctx: Ctx, channelId: string, opts: { after?: Date; limit?: number } = {}): Promise<ChatMessage[]> {
  await channelFor(ctx, channelId);
  const limit = Math.min(opts.limit ?? 100, 200);
  const rows = opts.after
    ? await messages(ctx.orgId).find({ channelId, at: { $gt: opts.after } } as never, { sort: { at: 1 }, limit })
    : (await messages(ctx.orgId).find({ channelId } as never, { sort: { at: -1 }, limit })).reverse();
  await reads(ctx.orgId).updateOne({ _id: `${ctx.userId}:${channelId}` } as never, { $set: { userId: ctx.userId, channelId, at: new Date() }, $setOnInsert: { _id: `${ctx.userId}:${channelId}` } } as never, undefined, { upsert: true });
  return rows;
}

export async function sendMessage(ctx: Ctx, channelId: string, body: string, name: string): Promise<ChatMessage> {
  await channelFor(ctx, channelId);
  const text = body.replace(/\r\n/g, "\n").trim();
  if (!text) throw new AppError("VALIDATION", "Write a message first");
  if (text.length > MAX_BODY) throw new AppError("VALIDATION", `Messages can be up to ${MAX_BODY} characters`);
  const recent = await messages(ctx.orgId).count({ userId: ctx.userId, at: { $gt: new Date(Date.now() - RATE_WINDOW_MS) } } as never);
  if (recent >= RATE_MAX) throw new AppError("CONFLICT", "You are sending messages too fast. Wait a few seconds.");
  const m: ChatMessage = { _id: newId(), channelId, userId: ctx.userId, name: name.replace(/\s*\(.*?\)\s*/g, "").trim() || "Staff", body: text, at: new Date() };
  await messages(ctx.orgId).insertOne(m);
  await reads(ctx.orgId).updateOne({ _id: `${ctx.userId}:${channelId}` } as never, { $set: { userId: ctx.userId, channelId, at: new Date() }, $setOnInsert: { _id: `${ctx.userId}:${channelId}` } } as never, undefined, { upsert: true });
  return m;
}
