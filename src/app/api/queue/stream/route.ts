import { authorize } from "@/core/rbac/authorize";
import "@/core/auth"; // registers the session -> ctx resolver
import { subscribe } from "@/core/bus";
import { AppError } from "@/core/errors";


/** Server-Sent Events. Subscribed by the caller's own orgId only; branch-scoped when the caller has a branch. */
export async function GET(req: Request) {
  let ctx;
  try {
    ctx = await authorize("queue:view");
  } catch (e) {
    if (e instanceof AppError) return Response.json({ error: e.code }, { status: e.status });
    throw e;
  }
  const enc = new TextEncoder();
  let off: (() => void) | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      send("ready", { orgId: ctx.orgId });
      off = subscribe(ctx.orgId, (e) => {
        if (e.branchId && ctx.branchId && e.branchId !== ctx.branchId) return;
        send(e.type, { branchId: e.branchId, ...e.payload });
      });
      ping = setInterval(() => controller.enqueue(enc.encode(": ping\n\n")), 25000);
      req.signal.addEventListener("abort", () => {
        off?.();
        clearInterval(ping);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel() {
      off?.();
      clearInterval(ping);
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
