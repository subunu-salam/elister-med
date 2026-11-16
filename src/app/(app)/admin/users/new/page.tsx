import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireCtx } from "@/lib/session";
import { Alert, NoAccess } from "@/ui/kit";
import { isSuperAdmin } from "@/modules/admin/service";
import { AccessFields } from "../../_fields";
import { addUser } from "../../actions";

export default async function NewUserPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireCtx();
  if (!isSuperAdmin(ctx)) return <NoAccess what="the control centre (super admin only)" />;
  const sp = await searchParams;
  const field = "w-full rounded-xl border border-border bg-surface-2 px-3 py-2";
  return (
    <div className="space-y-5">
      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} />Control centre</Link>
      <h1 className="text-2xl font-semibold">Add a person</h1>
      {sp.error && <Alert>{sp.error}</Alert>}
      <form action={addUser} className="space-y-6 rounded-3xl border border-border bg-surface p-5 shadow-card">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-sm"><span className="mb-1 block font-medium">Full name</span><input name="name" required className={field} /></label>
          <label className="text-sm"><span className="mb-1 block font-medium">Job title (optional)</span><input name="title" placeholder="e.g. Investor, Group CFO" className={field} /></label>
          <label className="text-sm"><span className="mb-1 block font-medium">Email (their login)</span><input name="email" type="email" required className={field} /></label>
          <label className="text-sm"><span className="mb-1 block font-medium">Temporary password</span><input name="password" type="text" minLength={12} required autoComplete="off" placeholder="At least 12 characters" className={field} /></label>
        </div>
        <AccessFields roles={[]} modules={null} canGrantPlatform={ctx.roles.includes("platform_super_admin")} />
        <div className="flex justify-end"><button className="rounded-xl brand-grad px-5 py-2.5 text-sm font-semibold text-white shadow-lg">Add person</button></div>
      </form>
    </div>
  );
}
