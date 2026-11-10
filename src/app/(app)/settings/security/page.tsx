import { requireCtx } from "@/lib/session";
import { PageHeader, Card } from "@/ui/kit";
import { MfaSetup } from "./MfaSetup";
import { Avatar } from "@/ui/avatar";
import { PhotoUpload } from "@/ui/PhotoUpload";
import { photoVersions } from "@/modules/people/photos";

export default async function SecurityPage() {
  const ctx = await requireCtx();
  const photo = (await photoVersions(ctx.orgId, [ctx.userId])).get(ctx.userId) ?? null;
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <PageHeader title="Security" sub={ctx.email} />
      <Card title="Your photo"><div className="flex items-center gap-5"><Avatar name={ctx.name} userId={ctx.userId} photo={photo} size={84} className="ring-4 ring-tint" /><div className="space-y-2"><p className="text-sm text-muted">Shown to colleagues in chat and on the doctor cards. A square picture works best.</p><PhotoUpload userId={ctx.userId} label={photo ? "Change photo" : "Upload photo"} hasPhoto={!!photo} /></div></div></Card>
      <Card title="Two-factor authentication (TOTP)"><MfaSetup /></Card>
      <Card title="Your access"><p className="text-sm text-muted">Roles: {ctx.roles.join(", ").replaceAll("_", " ")}. Every action is permission-checked on the server and written to the audit log.</p></Card>
    </div>
  );
}
