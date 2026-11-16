import Link from "next/link";
import { Phone } from "lucide-react";
import { requireCtx } from "@/lib/session";
import { NoAccess } from "@/ui/kit";
import { briefHistory, canBrief, getBrief } from "@/modules/ai/brief";
import { BriefPlayer } from "@/ui/voice/BriefPlayer";
import { AssistantSetup } from "@/ui/voice/AssistantSetup";

export const metadata = { title: "Personal assistant" };

export default async function BriefPage({ searchParams }: { searchParams: Promise<{ lang?: string }> }) {
  const ctx = await requireCtx();
  if (!canBrief(ctx)) return <NoAccess what="the personal assistant" />;
  const sp = await searchParams;
  const [brief, history] = await Promise.all([getBrief(ctx, sp.lang === "ml" ? "ml" : sp.lang === "en" ? "en" : undefined), briefHistory(ctx)]);
  return (
    <div className="space-y-5">
      <BriefPlayer initial={{ ...brief, generatedAt: brief.generatedAt.toISOString() }} history={history} />
      <Link href="/ai/call" className="flex items-center gap-3 rounded-3xl border border-border bg-surface p-4 shadow-card transition hover:border-primary">
        <span className="grid size-11 place-items-center rounded-full bg-[#1fbf75] text-white"><Phone size={20} /></span>
        <span className="flex-1"><span className="block font-semibold">Take this report as a call</span><span className="text-sm text-muted">Full-screen call: Elister talks you through the day, then you ask anything.</span></span>
      </Link>
      <AssistantSetup initial={brief.prefs} allowed={brief.allowed} />
    </div>
  );
}
