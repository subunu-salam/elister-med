import "server-only";
import { headers } from "next/headers";
import { getAuth, loadCtx } from "@/core/auth";
import { AppError } from "@/core/errors";
import type { Ctx } from "@/core/rbac/authorize";

/** Signed-in context plus display name for route handlers. Throws AppError("UNAUTHENTICATED") rather than redirecting. */
export async function apiCtx(): Promise<Ctx & { name: string }> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session?.user) throw new AppError("UNAUTHENTICATED", "Not signed in");
  const ctx = await loadCtx(session.user.id);
  if (!ctx) throw new AppError("UNAUTHENTICATED", "Not signed in");
  return { ...ctx, name: session.user.name };
}

/** Wraps a handler so AppErrors become JSON errors with the right status and nothing else leaks. */
export async function respond(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError) return Response.json({ error: e.message, code: e.code }, { status: e.status });
    console.error(e);
    return Response.json({ error: "Something went wrong" }, { status: 500 });
  }
}

/** JSON POST bodies only: a cross-site form cannot send application/json without a CORS preflight. */
export async function jsonBody<T>(req: Request): Promise<T> {
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) throw new AppError("VALIDATION", "Expected JSON");
  try { return (await req.json()) as T; } catch { throw new AppError("VALIDATION", "Invalid JSON"); }
}
