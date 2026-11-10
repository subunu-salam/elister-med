"use server";
import { run, requireCtx } from "@/lib/session";
import { reverseJournal } from "@/modules/ledger/journal";
import { lockPeriod } from "@/modules/ledger/periods";

export async function reverseAction(fd: FormData) {
  const ctx = await requireCtx();
  await run("/accounting?tab=journal", async () => { await reverseJournal(ctx, String(fd.get("entryId")), String(fd.get("reason") ?? "")); });
}
export async function lockAction(fd: FormData) {
  const ctx = await requireCtx();
  await run("/accounting?tab=periods", async () => { await lockPeriod(ctx, Number(fd.get("year")), Number(fd.get("month"))); });
}
