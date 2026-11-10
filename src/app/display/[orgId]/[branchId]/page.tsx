import { notFound } from "next/navigation";
import { publicBoard } from "@/modules/queue/service";
import Image from "next/image";
import { RefreshEvery } from "./RefreshEvery";

export const metadata = { title: "Queue display" };

/**
 * Public waiting-room screen. Shows token numbers and status only: no patient names or clinical data.
 * Protected by a shared display key (DISPLAY_KEY) so org/branch ids alone are not enough.
 */
export default async function DisplayPage({ params, searchParams }: { params: Promise<{ orgId: string; branchId: string }>; searchParams: Promise<{ key?: string }> }) {
  const { orgId, branchId } = await params;
  const { key } = await searchParams;
  if (!process.env.DISPLAY_KEY || key !== process.env.DISPLAY_KEY) notFound();
  const rows = await publicBoard(orgId, decodeURIComponent(branchId));
  const now = rows.filter((r) => r.status === "called" || r.status === "in_consult");
  const waiting = rows.filter((r) => r.status === "waiting");
  return (
    <main className="side-grad min-h-screen p-8 text-white">
      <RefreshEvery seconds={5} />
      <div className="mb-8 flex items-center justify-between"><h1 className="text-4xl font-semibold tracking-tight">Now serving</h1><Image src="/brand/logo-header.png" alt="Elister Med" width={227} height={109} className="h-14 w-auto" priority /></div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {now.map((r) => (
          <div key={r.number} className="rounded-3xl border border-cyan-300/30 bg-white/10 p-8 shadow-[0_20px_60px_-20px_rgba(0,0,0,.5)] backdrop-blur"><div className="text-6xl font-bold tabular-nums">{r.number}</div><div className="mt-2 text-xl text-teal-200">{r.doctorLabel}</div></div>
        ))}
        {now.length === 0 && <p className="text-xl text-white/60">—</p>}
      </div>
      <h2 className="mb-3 mt-10 text-xl text-white/70">Waiting</h2>
      <div className="flex flex-wrap gap-3">{waiting.map((r) => <span key={r.number} className="rounded-xl bg-white/10 px-4 py-2 text-2xl font-semibold tabular-nums">{r.number}</span>)}</div>
    </main>
  );
}
