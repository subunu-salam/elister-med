import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth, loadCtx } from "@/core/auth";
import { AppError } from "@/core/errors";
import type { Ctx } from "@/core/rbac/authorize";
import { normalizeLocale, type Locale } from "@/i18n";

/** Current signed-in context, or redirect to /login. Memoised per request. */
export const requireCtx = cache(async (): Promise<Ctx & { name: string; email: string }> => {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/login");
  const ctx = await loadCtx(session.user.id);
  if (!ctx) redirect("/login?error=no-membership");
  return { ...ctx, name: session.user.name, email: session.user.email };
});

export async function getLocale(): Promise<Locale> {
  return normalizeLocale((await cookies()).get("locale")?.value);
}

/** Runs a mutation; on AppError redirects back with the message instead of crashing the page. */
export async function run(back: string, fn: () => Promise<string | void>): Promise<never> {
  let dest = back;
  try {
    const to = await fn();
    if (typeof to === "string") dest = to;
  } catch (e) {
    if (e instanceof AppError) {
      const sep = back.includes("?") ? "&" : "?";
      redirect(`${back}${sep}error=${encodeURIComponent(e.message)}`);
    }
    throw e;
  }
  redirect(dest);
}
