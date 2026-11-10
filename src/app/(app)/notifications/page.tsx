import Link from "next/link";
import { requireCtx } from "@/lib/session";
import { listMyNotifications } from "@/core/notify";
import { Badge, Card, PageHeader } from "@/ui/kit";
import { ActionButton, fmtDateTime } from "@/ui/forms";

const HREF: Record<string, (id: string) => string> = { lab_order: (id) => `/laboratory/${id}`, rad_order: () => "/radiology" };

export default async function NotificationsPage() {
  const ctx = await requireCtx();
  const rows = await listMyNotifications(ctx, 100);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title="Notifications" actions={<ActionButton action="notify.readAll" back="/notifications">Mark all read</ActionButton>} />
      <Card>
        {rows.length === 0 ? <p className="text-sm text-muted">Nothing yet.</p> : (
          <ul className="divide-y divide-border">{rows.map((n) => (
            <li key={n._id} className="flex items-start justify-between gap-3 py-2.5">
              <div><div className="flex items-center gap-2 text-sm">{!n.read && <span className="size-2 rounded-full bg-primary" aria-label="unread" />}{n.refType && n.refId && HREF[n.refType] ? <Link className="hover:underline" href={HREF[n.refType](n.refId)}>{n.title}</Link> : n.title}</div><div className="text-xs text-muted">{fmtDateTime(n.at)}</div></div>
              {n.severity !== "info" && <Badge tone={n.severity === "critical" ? "danger" : "warn"}>{n.severity}</Badge>}
            </li>))}</ul>
        )}
      </Card>
    </div>
  );
}
