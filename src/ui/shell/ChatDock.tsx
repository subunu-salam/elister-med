"use client";
import { useCallback, useEffect, useState } from "react";
import { MessageCircle, Maximize2, Minimize2, Minus } from "lucide-react";
import { Chat, type ChatData } from "@/ui/shell/Chat";
import { cn } from "@/ui/kit";

const KEY = "chat-dock";
const total = (d: ChatData) => d.channels.reduce((a, c) => a + c.unread, 0);

/**
 * Staff chat as a floating dock on every page: a small "Messages" pill at the bottom corner that opens a compact panel
 * (pick a colleague or channel, one view at a time) and can be maximised to a wide two-pane window. Remembers its state.
 */
export function ChatDock() {
  const [open, setOpen] = useState(false);
  const [max, setMax] = useState(false);
  const [wide, setWide] = useState(true);
  const [data, setData] = useState<ChatData | null>(null);
  const [fresh, setFresh] = useState(false);
  const [failed, setFailed] = useState(false);
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/chat/channels", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as ChatData;
      setData(j); setUnread(total(j)); setFailed(false); setFresh(true);
    } catch { setFailed(true); }
  }, []);

  /* Browser-only state: saved dock state, screen width, and the first unread count. */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    try { const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as { open?: boolean; max?: boolean } | null; if (s?.open) setOpen(true); if (s?.max) setMax(true); } catch { /* storage unavailable */ }
    const mq = window.matchMedia("(min-width: 768px)");
    const on = () => setWide(mq.matches);
    on(); mq.addEventListener("change", on);
    void load();
    return () => mq.removeEventListener("change", on);
  }, [load]);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify({ open, max })); } catch { /* ignore */ } }, [open, max]);
  useEffect(() => { if (open) { setFresh(false); void load(); } }, [open, load]);
  /* eslint-enable react-hooks/set-state-in-effect */
  /* While the dock is closed it still checks for new messages, so the badge stays honest. */
  useEffect(() => {
    if (open) return;
    const t = setInterval(() => { if (!document.hidden) void load(); }, 10000);
    return () => clearInterval(t);
  }, [open, load]);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} aria-label={unread ? `Open messages, ${unread} unread` : "Open messages"}
        className="no-print fixed bottom-4 end-4 z-40 flex h-12 items-center gap-2.5 rounded-full bg-ink ps-4 pe-5 text-sm font-medium text-[var(--btn-fg)] shadow-[0_18px_40px_-16px_rgba(11,53,88,.7)] transition hover:-translate-y-0.5 active:scale-95">
        <MessageCircle size={18} />Messages
        {unread > 0 && <span className="grid min-w-5 place-items-center rounded-full brand-grad px-1.5 text-[11px] font-semibold text-white">{unread > 99 ? "99+" : unread}</span>}
      </button>
    );
  }

  const full = max && !wide; // phones: maximised means the whole screen
  return (
    <section role="dialog" aria-label="Team chat" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
      className={cn("dock-in no-print fixed z-40 flex origin-bottom-right flex-col overflow-hidden rounded-[28px] bg-surface shadow-[var(--shadow-pop)] ring-1 ring-border transition-[width,height] duration-300 ease-out",
        full ? "inset-2" : max ? "bottom-4 end-4 h-[min(42rem,calc(100dvh-2rem))] w-[min(64rem,calc(100vw-2rem))]" : "bottom-4 end-4 h-[min(34rem,calc(100dvh-2rem))] w-[min(23rem,calc(100vw-2rem))]")}>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="grid size-8 place-items-center rounded-full brand-grad text-white"><MessageCircle size={16} /></span>
        <h2 className="text-[15px] font-medium">Team chat</h2>
        {unread > 0 && <span className="grid min-w-5 place-items-center rounded-full bg-tint px-1.5 text-[11px] font-semibold text-primary">{unread} new</span>}
        <span className="ms-auto flex items-center gap-1">
          <button onClick={() => setMax((m) => !m)} aria-label={max ? "Make smaller" : "Make bigger"} title={max ? "Make smaller" : "Make bigger"} className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-surface-2 hover:text-fg">{max ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
          <button onClick={() => setOpen(false)} aria-label="Minimise chat" title="Minimise" className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-surface-2 hover:text-fg"><Minus size={18} /></button>
        </span>
      </header>
      <div className="min-h-0 flex-1">
        {data && fresh ? <Chat initial={data} split={max && wide} onUnread={setUnread} />
          : failed ? <div className="grid h-full place-items-center p-6 text-center text-sm text-muted"><div>Chat could not load.<br /><button onClick={() => void load()} className="mt-2 font-medium text-primary hover:underline">Try again</button></div></div>
          : <div className="grid h-full place-items-center text-sm text-muted">Loading…</div>}
      </div>
    </section>
  );
}
