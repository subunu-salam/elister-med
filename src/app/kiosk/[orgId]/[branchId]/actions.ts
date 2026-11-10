"use server";
import { redirect } from "next/navigation";
import { AppError } from "@/core/errors";
import { kioskCheckIn } from "@/modules/portal/service";

/** Public kiosk: validates the device key, then checks in by the appointment's QR token. Reveals only the queue number. */
export async function kioskAction(fd: FormData) {
  const orgId = String(fd.get("orgId")), branchId = String(fd.get("branchId")), key = String(fd.get("key"));
  const base = `/kiosk/${encodeURIComponent(orgId)}/${encodeURIComponent(branchId)}?key=${encodeURIComponent(key)}`;
  if (!process.env.KIOSK_KEY || key !== process.env.KIOSK_KEY) redirect("/login");
  try {
    const r = await kioskCheckIn(orgId, branchId, String(fd.get("token") ?? "").trim());
    redirect(`${base}&done=${r.tokenNumber}`);
  } catch (e) {
    if (e instanceof AppError) redirect(`${base}&error=${encodeURIComponent(e.message)}`);
    throw e;
  }
}
