"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Hash, MessageSquarePlus, Search, SendHorizontal } from "lucide-react";
import { Avatar } from "@/ui/avatar";
import { cn } from "@/ui/kit";

type Person = { userId: string; name: string; roles: string[]; specialty?: string; photo: number | null };
type Chan = { _id: string; kind: "channel" | "dm"; name: string; description?: string; members?: string[]; unread: number; last?: { body: string; at: string; name: string } };
type Msg = { _id: string; channelId: string; userId: string; name: string; body: string; at: string; pending?: boolean };

const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", weekday: "long", day: "numeric", month: "long" });
const role = (r: string[]) => r[0]?.replaceAll("_", " ") ?? "";

async function api<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? "Request failed");
  return j as T;
}

export type ChatData = { me: string; channels: Chan[]; people: Person[] };

/** `split` shows the list and the conversation side by side (maximised dock); otherwise one at a time (small dock, phones). */
export function Chat({ initial, split, onUnread }: { initial: ChatData; split: boolean; onUnread?: (n: number) => void }) {
  const [me] = useState(initial.me);
  const [channels, setChannels] = useState(initial.channels);
  const [people, setPeople] = useState(initial.people);
  const [active, setActive] = useState<string>(initial.channels[0]?._id ?? "");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [mobileThread, setMobileThread] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastAt = useRef<string | undefined>(undefined);
  const activeRef = useRef(active);

  const person = useMemo(() => new Map(people.map((p) => [p.userId, p])), [people]);
  const dmWith = useMemo(() => new Map(channels.filter((c) => c.kind === "dm").map((c) => [c.members?.find((m) => m !== me) ?? "", c])), [channels, me]);
  const current = channels.find((c) => c._id === active);
  const title = current?.kind === "dm" ? person.get(current.members?.find((m) => m !== me) ?? "")?.name ?? current.name : current?.name ?? "";

  const refreshList = useCallback(async () => {
    try { const j = await api<{ channels: Chan[]; people: Person[] }>("/api/chat/channels"); setChannels(j.channels); setPeople(j.people); onUnread?.(j.channels.reduce((a, c) => a + c.unread, 0)); } catch { /* keep what is shown */ }
  }, [onUnread]);

  /* Load a conversation, then poll it for new messages while the tab is visible. */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    activeRef.current = active;
    lastAt.current = undefined; stick.current = true; setMsgs([]); setErr("");
    if (!active) return;
    let stop = false;
    const pull = async (force = false) => {
      if (stop || (document.hidden && !force)) return;
      try {
        const j = await api<{ messages: Msg[] }>(`/api/chat/messages?c=${encodeURIComponent(active)}${lastAt.current ? `&after=${encodeURIComponent(lastAt.current)}` : ""}`);
        if (stop || activeRef.current !== active || !j.messages.length) return;
        lastAt.current = j.messages[j.messages.length - 1].at;
        setMsgs((cur) => { const ids = new Set(cur.map((m) => m._id)); return [...cur.filter((m) => !m.pending || !j.messages.some((n) => n.body === m.body && n.userId === m.userId)), ...j.messages.filter((m) => !ids.has(m._id))]; });
        void refreshList();
      } catch { /* try again on the next tick */ }
    };
    void pull(true);
    const t = setInterval(() => void pull(), 2500);
    return () => { stop = true; clearInterval(t); };
  }, [active, refreshList]);
  /* eslint-enable react-hooks/set-state-in-effect */
  useEffect(() => { const t = setInterval(() => { if (!document.hidden) void refreshList(); }, 8000); return () => clearInterval(t); }, [refreshList]);
  useEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [msgs]);

  async function send() {
    const body = draft.trim();
    if (!body || !active) return;
    setDraft(""); setErr(""); stick.current = true;
    const temp: Msg = { _id: `tmp-${Date.now()}`, channelId: active, userId: me, name: person.get(me)?.name ?? "You", body, at: new Date().toISOString(), pending: true };
    setMsgs((m) => [...m, temp]);
    try {
      const j = await api<{ message: Msg }>("/api/chat/messages", { c: active, body });
      lastAt.current = j.message.at;
      setMsgs((m) => m.map((x) => (x._id === temp._id ? j.message : x)));
      void refreshList();
    } catch (e) {
      setMsgs((m) => m.filter((x) => x._id !== temp._id));
      setDraft(body); setErr(e instanceof Error ? e.message : "Could not send");
    }
  }
  async function openDm(userId: string) {
    try {
      const j = await api<{ channel: Chan }>("/api/chat/dm", { userId });
      await refreshList();
      setActive(j.channel._id); setMobileThread(true);
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not open the conversation"); }
  }

  const others = people.filter((p) => p.userId !== me && p.name.toLowerCase().includes(q.toLowerCase()));
  const groups = channels.filter((c) => c.kind === "channel");
  const row = "flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-start transition-colors";

  return (
    <div className={cn("grid h-full min-h-0 overflow-hidden", split && "grid-cols-[19rem_1fr]")}>
      <aside className={cn("flex min-h-0 flex-col border-border", split && "border-e", !split && mobileThread && "hidden")}>
        <div className="p-3 pb-2">
          <label className="flex items-center gap-2 rounded-full bg-surface-2 px-4 py-2 text-sm"><Search size={15} className="text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a colleague" aria-label="Find a colleague" className="w-full bg-transparent outline-none placeholder:text-muted" /></label>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {!q && <>
            <p className="px-3 pb-1 pt-3 text-xs font-medium text-muted">Channels</p>
            {groups.map((c) => (
              <button key={c._id} onClick={() => { setActive(c._id); setMobileThread(true); }} className={cn(row, c._id === active ? "bg-tint" : "hover:bg-surface-2")}>
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-tint text-primary"><Hash size={17} /></span>
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{c.name}</span><span className="block truncate text-xs text-muted">{c.last ? `${c.last.name.split(" ")[0]}: ${c.last.body}` : c.description}</span></span>
                {c.unread > 0 && <span className="grid min-w-5 place-items-center rounded-full brand-grad px-1.5 text-[11px] font-semibold text-white">{c.unread}</span>}
              </button>
            ))}
          </>}
          <p className="px-3 pb-1 pt-4 text-xs font-medium text-muted">{q ? "People" : "Direct messages"}</p>
          {others.map((p) => {
            const dm = dmWith.get(p.userId);
            return (
              <button key={p.userId} onClick={() => openDm(p.userId)} className={cn(row, dm && dm._id === active ? "bg-tint" : "hover:bg-surface-2")}>
                <Avatar name={p.name} userId={p.userId} photo={p.photo} size={40} />
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{p.name}</span><span className="block truncate text-xs capitalize text-muted">{dm?.last ? dm.last.body : p.specialty ?? role(p.roles)}</span></span>
                {dm && dm.unread > 0 && <span className="grid min-w-5 place-items-center rounded-full brand-grad px-1.5 text-[11px] font-semibold text-white">{dm.unread}</span>}
              </button>
            );
          })}
          {others.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted">{q ? "No one matches that name." : "No other staff yet."}</p>}
        </div>
      </aside>

      <section className={cn("flex min-h-0 flex-col", !split && !mobileThread && "hidden")}>
        {current ? <>
          <header className="flex items-center gap-3 border-b border-border px-4 py-3">
            <button onClick={() => setMobileThread(false)} aria-label="Back to conversations" className={cn("size-9 place-items-center rounded-full hover:bg-surface-2", split ? "hidden" : "grid")}><ArrowLeft size={18} /></button>
            {current.kind === "dm"
              ? (() => { const o = person.get(current.members?.find((m) => m !== me) ?? ""); return <Avatar name={o?.name ?? title} userId={o?.userId} photo={o?.photo} size={40} />; })()
              : <span className="grid size-10 place-items-center rounded-full bg-tint text-primary"><Hash size={18} /></span>}
            <div className="min-w-0"><h3 className="truncate text-[15px] font-medium">{title}</h3><p className="truncate text-xs text-muted">{current.kind === "dm" ? "Direct message, only you two can see this" : current.description}</p></div>
          </header>
          <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className="min-h-0 flex-1 space-y-1 overflow-y-auto px-4 py-4" aria-live="polite">
            {msgs.length === 0 && <div className="grid h-full place-items-center text-center text-sm text-muted"><div><MessageSquarePlus className="mx-auto mb-2 text-primary" size={28} strokeWidth={1.5} />No messages yet. Say hello.</div></div>}
            {msgs.map((m, i) => {
              const mine = m.userId === me, prev = msgs[i - 1];
              const newDay = !prev || day(prev.at) !== day(m.at);
              const first = newDay || prev.userId !== m.userId || +new Date(m.at) - +new Date(prev.at) > 5 * 60_000;
              const p = person.get(m.userId);
              return (
                <div key={m._id}>
                  {newDay && <div className="my-3 text-center text-xs text-muted">{day(m.at)}</div>}
                  <div className={cn("flex items-end gap-2", mine && "flex-row-reverse", first ? "mt-3" : "mt-0.5")}>
                    <div className="w-8 shrink-0">{first && !mine && <Avatar name={m.name} userId={p?.userId} photo={p?.photo} size={32} />}</div>
                    <div className={cn("max-w-[78%]", mine && "items-end")}>
                      {first && !mine && <p className="mb-0.5 ps-1 text-xs text-muted">{m.name}</p>}
                      <p className={cn("whitespace-pre-wrap break-words rounded-3xl px-4 py-2 text-sm leading-relaxed", mine ? "rounded-ee-lg bg-ink text-[var(--btn-fg)]" : "rounded-es-lg bg-surface-2", m.pending && "opacity-60")}>{m.body}</p>
                      {(first || i === msgs.length - 1 || msgs[i + 1].userId !== m.userId) && <p className={cn("mt-0.5 px-1 text-[10px] text-muted", mine && "text-end")}>{m.pending ? "Sending…" : time(m.at)}</p>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {err && <p role="alert" className="px-5 pb-1 text-xs text-danger">{err}</p>}
          <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="flex items-end gap-2 border-t border-border p-3">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={1} maxLength={2000} placeholder={`Message ${current.kind === "dm" ? title : "#" + title}`} aria-label="Message"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              className="max-h-32 min-h-11 flex-1 resize-none rounded-3xl border border-border bg-surface px-4 py-2.5 text-sm outline-none transition focus:border-primary focus:ring-4 focus:ring-primary/15" />
            <button disabled={!draft.trim()} aria-label="Send message" className="btn-gloss grid size-11 shrink-0 place-items-center rounded-full transition active:scale-95 disabled:opacity-40"><SendHorizontal size={18} /></button>
          </form>
        </> : <div className="grid flex-1 place-items-center text-sm text-muted">Pick a conversation.</div>}
      </section>
    </div>
  );
}
