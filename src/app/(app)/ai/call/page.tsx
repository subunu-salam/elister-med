import { requireCtx } from "@/lib/session";
import { NoAccess } from "@/ui/kit";
import { canBrief, getBrief } from "@/modules/ai/brief";
import { CallScreen } from "@/ui/voice/CallScreen";

export const metadata = { title: "Call · Elister AI" };

export default async function CallPage({ searchParams }: { searchParams: Promise<{ answer?: string }> }) {
  const ctx = await requireCtx();
  if (!canBrief(ctx)) return <NoAccess what="the personal assistant" />;
  const sp = await searchParams;
  const brief = await getBrief(ctx);
  const name = ctx.name.replace(/\(.*?\)/g, "").trim();
  return <CallScreen initial={brief} answered={sp.answer === "1"} name={name} />;
}
