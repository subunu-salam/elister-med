import { requireCtx } from "@/lib/session";
import { NoAccess } from "@/ui/kit";
import { briefHistory, canBrief, getBrief } from "@/modules/ai/brief";
import { BriefPlayer } from "@/ui/voice/BriefPlayer";

export const metadata = { title: "Daily brief" };

export default async function BriefPage({ searchParams }: { searchParams: Promise<{ lang?: string }> }) {
  const ctx = await requireCtx();
  if (!canBrief(ctx)) return <NoAccess what="the daily brief (owners and managers)" />;
  const sp = await searchParams;
  const [brief, history] = await Promise.all([getBrief(ctx, sp.lang === "ml" ? "ml" : "en"), briefHistory(ctx)]);
  return <BriefPlayer initial={{ ...brief, generatedAt: brief.generatedAt.toISOString() }} history={history} />;
}
