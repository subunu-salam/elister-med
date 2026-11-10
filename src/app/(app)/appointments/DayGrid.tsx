"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { rescheduleAction } from "./actions";
import { cn } from "@/ui/kit";

export type GridDoctor = {
  id: string; name: string; startMin: number; endMin: number; slot: number; works: boolean;
  appts: { id: string; label: string; startMin: number; endMin: number; status: string }[];
};

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Day scheduler. Drag a booked appointment onto a free slot to reschedule; the server re-validates everything. */
export function DayGrid({ date, doctors }: { date: string; doctors: GridDoctor[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [over, setOver] = useState<string>("");

  const minStart = Math.min(...doctors.filter((d) => d.works).map((d) => d.startMin), 9 * 60);
  const maxEnd = Math.max(...doctors.filter((d) => d.works).map((d) => d.endMin), 17 * 60);
  const step = Math.min(...doctors.map((d) => d.slot), 20);
  const rows: number[] = [];
  for (let m = minStart; m < maxEnd; m += step) rows.push(m);

  function drop(e: React.DragEvent, doctor: GridDoctor, m: number) {
    e.preventDefault(); setOver("");
    const raw = e.dataTransfer.getData("text/plain");
    if (!raw) return;
    const { id, len } = JSON.parse(raw) as { id: string; len: number };
    const s = new Date(`${date}T${hhmm(m)}:00+04:00`);
    start(async () => {
      const r = await rescheduleAction(id, s.toISOString(), new Date(s.getTime() + len * 60000).toISOString(), doctor.id);
      setMsg(r.ok ? { tone: "ok", text: `Moved to ${hhmm(m)} with ${doctor.name}` } : { tone: "err", text: r.error ?? "Could not reschedule" });
      router.refresh();
    });
  }

  return (
    <div className="space-y-2">
      <div aria-live="polite" className="min-h-5 text-sm">{msg && <span className={msg.tone === "ok" ? "text-ok" : "text-danger"}>{msg.text}</span>}{pending && <span className="text-muted"> Saving…</span>}</div>
      <div className="overflow-x-auto rounded-ui border border-border">
        <table className="w-full min-w-[520px] border-collapse text-xs">
          <thead>
            <tr className="bg-surface-2"><th className="w-16 p-2 text-start font-medium text-muted">Time</th>{doctors.map((d) => <th key={d.id} className="p-2 text-start font-medium">{d.name}{!d.works && <span className="ms-1 text-muted">(off)</span>}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m} className="border-t border-border">
                <td className="p-2 tabular-nums text-muted">{hhmm(m)}</td>
                {doctors.map((d) => {
                  const a = d.appts.find((x) => x.startMin >= m && x.startMin < m + step);
                  const inHours = d.works && m >= d.startMin && m + step <= d.endMin;
                  const covered = d.appts.some((x) => x.startMin < m && x.endMin > m);
                  const key = `${d.id}-${m}`;
                  return (
                    <td key={key}
                      onDragOver={(e) => { if (inHours && !a && !covered) { e.preventDefault(); setOver(key); } }}
                      onDragLeave={() => setOver("")}
                      onDrop={(e) => inHours && !a && !covered && drop(e, d, m)}
                      className={cn("h-9 border-s border-border p-1 align-top", !inHours && "bg-surface-2/60", over === key && "bg-primary/15")}>
                      {a && (
                        <div draggable={a.status === "booked"} tabIndex={0}
                          onDragStart={(e) => e.dataTransfer.setData("text/plain", JSON.stringify({ id: a.id, len: a.endMin - a.startMin }))}
                          className={cn("rounded px-2 py-1 text-[11px] leading-tight", a.status === "booked" ? "cursor-grab bg-primary/15 text-primary" : a.status === "completed" ? "bg-ok/15 text-ok" : a.status === "cancelled" || a.status === "no_show" ? "bg-danger/10 text-danger line-through" : "bg-accent/15 text-accent")}
                          title={a.status === "booked" ? "Drag to reschedule" : a.status}>
                          {a.label}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
