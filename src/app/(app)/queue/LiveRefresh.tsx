"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** Subscribes to the org-scoped SSE stream and refreshes server data when the queue changes. */
export function LiveRefresh() {
  const router = useRouter();
  const [live, setLive] = useState(false);
  useEffect(() => {
    const es = new EventSource("/api/queue/stream");
    es.addEventListener("ready", () => setLive(true));
    es.addEventListener("queue.updated", () => router.refresh());
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [router]);
  return <span className={`inline-flex items-center gap-1.5 text-xs ${live ? "text-ok" : "text-muted"}`} aria-live="polite"><span className={`size-2 rounded-full ${live ? "bg-ok" : "bg-muted"}`} />{live ? "Live" : "Reconnecting…"}</span>;
}
