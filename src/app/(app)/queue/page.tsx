import { requireCtx } from "@/lib/session";
import { listDoctors } from "@/modules/appointments/service";
import { listTodayTokens, estimateWaitMinutes } from "@/modules/queue/service";
import { patientNames } from "@/modules/patients/service";
import { Alert, Badge, Button, Card, NoAccess, PageHeader } from "@/ui/kit";
import { LiveRefresh } from "./LiveRefresh";
import { callNextAction, skipAction, startConsultAction } from "./actions";

const TONE = { waiting: "warn", called: "info", in_consult: "info", done: "ok", skipped: "danger" } as const;

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireCtx();
  const { error } = await searchParams;
  if (!ctx.permissions.includes("queue:view")) return <NoAccess what="the queue" />;
  const doctors = await listDoctors(ctx);
  const tokens = await listTodayTokens(ctx, ctx.branchId);
  const names = await patientNames(ctx, tokens.map((t) => t.patientId));
  const can = (p: string) => ctx.permissions.includes(p as never);
  const waits = new Map<string, number>();
  for (const d of doctors) waits.set(d._id, await estimateWaitMinutes(ctx, d._id));

  return (
    <div className="space-y-4">
      <PageHeader title="Queue" sub="Today, this branch" actions={<LiveRefresh />} />
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {doctors.map((d) => {
          const mine = tokens.filter((t) => t.doctorId === d._id);
          const active = mine.filter((t) => ["waiting", "called", "in_consult"].includes(t.status));
          return (
            <Card key={d._id} title={d.name} action={<Badge tone="neutral">~{waits.get(d._id)} min wait</Badge>}>
              <ul className="space-y-2">
                {active.map((t) => (
                  <li key={t._id} className="flex items-center justify-between gap-2 rounded-ui border border-border p-2">
                    <div className="flex items-center gap-3">
                      <div className="grid size-9 place-items-center rounded-lg bg-surface-2 text-sm font-semibold tabular-nums">{t.number}</div>
                      <div><div className="text-sm">{names.get(t.patientId)?.fullName ?? "Patient"}</div><div className="text-xs text-muted">{t.priority > 0 && "Priority · "}<Badge tone={TONE[t.status]}>{t.status.replace("_", " ")}</Badge></div></div>
                    </div>
                    <div className="flex gap-1">
                      {t.status === "called" && can("emr:create") && <form action={startConsultAction}><input type="hidden" name="appointmentId" value={t.appointmentId} /><Button className="px-2 py-1 text-xs">Start consult</Button></form>}
                      {t.status === "in_consult" && can("emr:view") && <form action={startConsultAction}><input type="hidden" name="appointmentId" value={t.appointmentId} /><Button variant="outline" className="px-2 py-1 text-xs">Open</Button></form>}
                      {(t.status === "waiting" || t.status === "called") && can("queue:update") && <form action={skipAction}><input type="hidden" name="tokenId" value={t._id} /><Button variant="ghost" className="px-2 py-1 text-xs">Skip</Button></form>}
                    </div>
                  </li>
                ))}
                {active.length === 0 && <li className="py-4 text-center text-sm text-muted">No patients waiting.</li>}
              </ul>
              {can("queue:update") && <form action={callNextAction} className="mt-3"><input type="hidden" name="doctorId" value={d._id} /><Button variant="outline" className="w-full">Call next</Button></form>}
            </Card>
          );
        })}
      </div>
      {doctors.length === 0 && <Card><p className="text-sm text-muted">No doctors configured.</p></Card>}
    </div>
  );
}
