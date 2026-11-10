import { tenantCol } from "@/core/db";
import { AppError } from "@/core/errors";
import type { Ctx } from "@/core/rbac/authorize";
import { patientNames } from "@/modules/patients/service";

export type SavedView = { id: string; page: "patients" | "appointments" | "billing" | "accounting" | "dashboard"; name: string; query: string };
export type Prefs = { userId: string; widgets: string[]; savedViews: SavedView[]; recentPatients: string[]; sidebarCollapsed?: boolean };
export const ALL_WIDGETS = ["executive", "reception", "doctor", "accounts", "pharmacy", "laboratory", "hospital", "compliance"] as const;
const col = (o: string) => tenantCol<Prefs & { _id: string }>(o, "user_prefs");
const blank = (userId: string): Prefs => ({ userId, widgets: [...ALL_WIDGETS], savedViews: [], recentPatients: [] });

/** Preferences belong to the signed-in user and are looked up by ctx.userId only. */
export async function getPrefs(ctx: Ctx): Promise<Prefs> {
  const p = await col(ctx.orgId).findOne({ userId: ctx.userId } as never);
  return { ...blank(ctx.userId), ...(p ?? {}) };
}
async function save(ctx: Ctx, set: Partial<Prefs>) {
  await col(ctx.orgId).updateOne({ userId: ctx.userId } as never, { $set: set, $setOnInsert: { _id: `${ctx.orgId}:${ctx.userId}` } } as never, undefined, { upsert: true });
}
export async function setWidgets(ctx: Ctx, widgets: string[]) {
  const bad = widgets.filter((w) => !(ALL_WIDGETS as readonly string[]).includes(w));
  if (bad.length) throw new AppError("VALIDATION", `Unknown widget: ${bad.join(", ")}`);
  await save(ctx, { widgets: [...new Set(widgets)] });
}
export async function saveView(ctx: Ctx, v: Omit<SavedView, "id">): Promise<SavedView> {
  if (!v.name.trim() || v.name.length > 60) throw new AppError("VALIDATION", "Give the view a short name");
  if (v.query.length > 500 || /[<>]/.test(v.query)) throw new AppError("VALIDATION", "Invalid filter");
  const p = await getPrefs(ctx);
  if (p.savedViews.length >= 25) throw new AppError("CONFLICT", "Too many saved views (25 max)");
  const view: SavedView = { ...v, id: Math.random().toString(36).slice(2, 10) };
  await save(ctx, { savedViews: [...p.savedViews, view] });
  return view;
}
export async function deleteView(ctx: Ctx, id: string) { const p = await getPrefs(ctx); await save(ctx, { savedViews: p.savedViews.filter((v) => v.id !== id) }); }
export async function setSidebarCollapsed(ctx: Ctx, collapsed: boolean) { await save(ctx, { sidebarCollapsed: collapsed }); }

/** Most-recent-first, max 8, no duplicates. Called when a patient record is opened. */
export async function touchRecentPatient(ctx: Ctx, patientId: string) {
  const p = await getPrefs(ctx);
  await save(ctx, { recentPatients: [patientId, ...p.recentPatients.filter((x) => x !== patientId)].slice(0, 8) });
}
export async function recentPatients(ctx: Ctx) {
  if (!ctx.permissions.includes("patients:view")) return [];
  const p = await getPrefs(ctx);
  const names = await patientNames(ctx, p.recentPatients);
  return p.recentPatients.filter((id) => names.has(id)).map((id) => ({ id, ...names.get(id)! }));
}
