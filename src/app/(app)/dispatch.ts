"use server";
import { requireCtx, run } from "@/lib/session";
import { ACTIONS } from "./actions-registry";

/**
 * Single entry point for module forms. Resolves a registered action by name and runs it with the signed-in user's context.
 * Authorization is NOT done here: every service function checks its own permission, so a forged form post gets the same answer
 * as the UI would. The return path must be a same-site relative URL.
 */
export async function dispatch(fd: FormData) {
  const ctx = await requireCtx();
  const name = String(fd.get("_a") ?? "");
  const raw = String(fd.get("_back") ?? "/dashboard");
  const back = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard";
  const fn = ACTIONS[name];
  if (!fn) throw new Error(`Unknown action: ${name}`);
  await run(back, async () => fn(ctx, fd, back));
}
