import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getAuth } from "@/core/auth";
import { tenantCol } from "@/core/db";
import { unreadCount } from "@/core/notify";
import { dirOf, t } from "@/i18n";
import { getLocale, requireCtx } from "@/lib/session";
import { NAV } from "@/ui/shell/nav";
import { Shell } from "@/ui/shell/Shell";
import { Skeleton } from "@/ui/kit";

async function setLocale() {
  "use server";
  const jar = await cookies();
  jar.set("locale", jar.get("locale")?.value === "ar" ? "en" : "ar", { path: "/", maxAge: 31536000, sameSite: "lax" });
  redirect("/dashboard");
}
async function signOut() {
  "use server";
  await getAuth().api.signOut({ headers: await headers() });
  redirect("/login");
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireCtx();
  const locale = await getLocale();
  const [org, branch, unread] = await Promise.all([
    tenantCol<{ name: string }>(ctx.orgId, "orgs").findOne({ _id: ctx.orgId } as never),
    tenantCol<{ name: string }>(ctx.orgId, "branches").findOne({ _id: ctx.branchId } as never),
    unreadCount(ctx),
  ]);
  const isPortal = ctx.roles.includes("patient_portal_user");
  const items = isPortal
    ? [{ href: "/portal", label: t(locale, "nav.portal"), icon: "portal" as const }]
    : NAV.filter((n) => !n.portal && ctx.permissions.includes(n.perm)).map((n) => ({ href: n.href, label: t(locale, n.labelKey), icon: n.icon }));
  const quick = [
    ctx.permissions.includes("patients:create") && { href: "/patients/new", label: t(locale, "patients.new") },
    ctx.permissions.includes("appointments:create") && { href: "/appointments", label: "Book appointment" },
  ].filter(Boolean) as { href: string; label: string }[];

  return (
    <Shell
      items={items} quick={quick} orgName={org?.name ?? "Organization"} branch={branch?.name ?? ""} userName={ctx.name}
      roles={ctx.roles.join(", ").replaceAll("_", " ")} locale={locale} dir={dirOf(locale)}
      labels={{ language: t(locale, "common.language"), signOut: t(locale, "common.signOut"), search: t(locale, "common.search") }}
      setLocale={setLocale} signOut={signOut} unread={unread} showChat={!isPortal}
    >
      <Suspense fallback={<div className="space-y-3"><Skeleton className="h-7 w-56" /><Skeleton className="h-32 w-full" /></div>}>{children}</Suspense>
    </Shell>
  );
}
