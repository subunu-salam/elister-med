import { createHash } from "node:crypto";
import { Binary } from "mongodb";
import { tenantCol, withTransaction } from "./db";
import { audit } from "./audit";
import { newId } from "./ids";
import { AppError } from "./errors";
import type { Ctx } from "./rbac/authorize";
import type { Permission } from "./rbac/permissions";

const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = ["application/pdf", "image/png", "image/jpeg", "text/plain"];

/** Which permission guards which kind of attachment. Reads and writes are both audited. */
const GUARD: Record<string, { add: Permission; read: Permission }> = {
  patient: { add: "emr:create", read: "emr:view" },
  compliance: { add: "compliance:create", read: "compliance:view" },
  hr: { add: "hr:create", read: "hr:view" },
  supplier: { add: "procurement:create", read: "procurement:view" },
};

export type AttachmentMeta = { _id: string; resourceType: string; resourceId: string; filename: string; contentType: string; size: number; sha256: string; uploadedBy: string; at: Date };
type Doc = AttachmentMeta & { content: Binary };
const col = (o: string) => tenantCol<Doc>(o, "attachments");

/** Stored in the tenant's own records (never a shared bucket). 2 MB cap and a type allow-list; large media belongs in dedicated object storage. */
export async function addAttachment(ctx: Ctx, input: { resourceType: string; resourceId: string; filename: string; contentType: string; base64: string }): Promise<AttachmentMeta> {
  const g = GUARD[input.resourceType];
  if (!g) throw new AppError("VALIDATION", "Unknown attachment target");
  if (!ctx.permissions.includes(g.add)) throw new AppError("FORBIDDEN", `Missing permission ${g.add}`);
  if (!TYPES.includes(input.contentType)) throw new AppError("VALIDATION", "File type not allowed");
  const buf = Buffer.from(input.base64, "base64");
  if (buf.length === 0 || buf.length > MAX_BYTES) throw new AppError("VALIDATION", "File is empty or larger than 2 MB");
  const meta: AttachmentMeta = { _id: newId(), resourceType: input.resourceType, resourceId: input.resourceId, filename: input.filename.replace(/[^\w.\- ]/g, "_").slice(0, 120), contentType: input.contentType, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), uploadedBy: ctx.userId, at: new Date() };
  await withTransaction(async (s) => {
    await col(ctx.orgId).insertOne({ ...meta, content: new Binary(buf) }, s);
    await audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "attachment.add", resource: input.resourceType, resourceId: input.resourceId, after: { attachmentId: meta._id, sha256: meta.sha256 } });
  });
  return meta;
}
export async function listAttachments(ctx: Ctx, resourceType: string, resourceId: string): Promise<AttachmentMeta[]> {
  const g = GUARD[resourceType];
  if (!g || !ctx.permissions.includes(g.read)) throw new AppError("FORBIDDEN", "Not permitted");
  const rows = await col(ctx.orgId).find({ resourceType, resourceId } as never, { sort: { at: -1 }, limit: 100 });
  return rows.map(({ content: _c, ...m }) => (void _c, m));
}
export async function getAttachment(ctx: Ctx, id: string): Promise<{ meta: AttachmentMeta; content: Buffer }> {
  const d = await col(ctx.orgId).findOne({ _id: id } as never);
  if (!d) throw new AppError("NOT_FOUND", "Attachment not found");
  const g = GUARD[d.resourceType];
  if (!g || !ctx.permissions.includes(g.read)) throw new AppError("FORBIDDEN", "Not permitted");
  await withTransaction((s) => audit(s, { orgId: ctx.orgId, actorId: ctx.userId, action: "attachment.read", resource: d.resourceType, resourceId: d.resourceId, after: { attachmentId: id } }));
  const { content, ...meta } = d;
  return { meta, content: Buffer.from(content.buffer) };
}
