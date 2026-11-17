import { requireCtx } from "@/lib/session";
import { NoAccess } from "@/ui/kit";
import { canBrief, getSchedule } from "@/modules/ai/brief";
import { ScheduleScreen } from "@/ui/voice/ScheduleScreen";

export const metadata = { title: "Scheduled calls" };

export default async function SchedulePage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const ctx = await requireCtx();
  if (!canBrief(ctx)) return <NoAccess what="the personal assistant" />;
  const [s, sp] = await Promise.all([getSchedule(ctx), searchParams]);
  return (
    <ScheduleScreen
      highlight={sp.from === "callback" ? "callback" : undefined}
      initial={{
        prefs: s.prefs, snoozeUntil: s.snoozeUntil?.toISOString() ?? null, calledToday: s.calledToday?.toISOString() ?? null,
        answeredToday: s.answeredToday?.toISOString() ?? null, upcoming: s.upcoming.map((u) => ({ ...u, at: u.at.toISOString() })),
      }}
    />
  );
}
