import { notFound } from "next/navigation";
import Image from "next/image";
import { kioskAction } from "./actions";

export const metadata = { title: "Self check-in" };

/** Reception kiosk. Patients type or scan the code from their confirmation. Protected by the device key (KIOSK_KEY). */
export default async function KioskPage({ params, searchParams }: { params: Promise<{ orgId: string; branchId: string }>; searchParams: Promise<{ key?: string; done?: string; error?: string }> }) {
  const { orgId, branchId } = await params;
  const { key = "", done, error } = await searchParams;
  if (!process.env.KIOSK_KEY || key !== process.env.KIOSK_KEY) notFound();
  return (
    <main className="side-grad grid min-h-screen place-items-center p-6 text-white">
      <div className="w-full max-w-md space-y-5 text-center">
        <Image src="/brand/logo-header.png" alt="Elister Med" width={227} height={109} className="mx-auto h-16 w-auto" priority />
        <h1 className="text-3xl font-semibold tracking-tight">Self check-in</h1>
        {done ? (
          <div className="rounded-2xl border border-teal-400/40 bg-teal-400/10 p-8"><p className="text-lg text-teal-100">You are checked in</p><p className="mt-2 text-7xl font-bold tabular-nums">{done}</p><p className="mt-2 text-white/70">Please wait for your number on the screen.</p></div>
        ) : (
          <form action={kioskAction} className="space-y-3">
            <input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="branchId" value={branchId} /><input type="hidden" name="key" value={key} />
            <label className="block text-start text-sm text-white/70">Appointment code<input name="token" required autoFocus autoComplete="off" className="mt-1 w-full rounded-xl border border-white/20 bg-white/10 px-4 py-3 text-xl text-white" /></label>
            <button className="w-full rounded-xl bg-cyan-300 px-4 py-3 text-lg font-semibold text-[#06344f]">Check in</button>
            {error && <p role="alert" className="rounded-xl bg-red-500/20 p-3 text-red-100">{error}</p>}
          </form>
        )}
      </div>
    </main>
  );
}
