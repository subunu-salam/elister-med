"use server";
import { requireCtx, run } from "@/lib/session";
import { createUser, ringUser, setAssistant, updateAccess } from "@/modules/admin/service";
import type { Lang, SectionKey } from "@/modules/ai/brief-core";

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const all = (fd: FormData, k: string) => fd.getAll(k).map(String);
/** "all" radio = no module restriction (role decides); "custom" = exactly the ticked modules. */
const modules = (fd: FormData) => (s(fd, "moduleMode") === "custom" ? all(fd, "modules") : null);

export async function saveAccess(fd: FormData) {
  const ctx = await requireCtx();
  const id = s(fd, "userId");
  await run(`/admin/users/${id}`, async () => {
    await updateAccess(ctx, id, { roles: all(fd, "roles"), modules: modules(fd), active: fd.get("active") === "on", title: s(fd, "title") });
    return `/admin/users/${id}?saved=access`;
  });
}

export async function addUser(fd: FormData) {
  const ctx = await requireCtx();
  await run("/admin/users/new", async () => {
    const id = await createUser(ctx, { name: s(fd, "name"), email: s(fd, "email"), password: String(fd.get("password") ?? ""), roles: all(fd, "roles"), modules: modules(fd), title: s(fd, "title") });
    return `/admin/users/${id}?saved=created`;
  });
}

export async function saveAssistant(fd: FormData) {
  const ctx = await requireCtx();
  const id = s(fd, "userId");
  await run(`/admin/users/${id}`, async () => {
    await setAssistant(ctx, id, {
      enabled: fd.get("enabled") === "on", callTime: s(fd, "callTime"), lang: (s(fd, "lang") === "ml" ? "ml" : "en") as Lang,
      days: all(fd, "days").map(Number), sections: all(fd, "sections") as SectionKey[], lock: fd.get("lock") === "on",
    });
    return `/admin/users/${id}?saved=assistant`;
  });
}

export async function ringNow(fd: FormData) {
  const ctx = await requireCtx();
  const id = s(fd, "userId");
  await run(`/admin/users/${id}`, async () => {
    const n = await ringUser(ctx, id);
    return `/admin/users/${id}?saved=${n ? "rang" : "rang0"}`;
  });
}
