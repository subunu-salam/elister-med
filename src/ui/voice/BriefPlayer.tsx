"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowUpRight, Check, Copy, Gauge, Keyboard, Mic, MicOff, Pause, Play, RefreshCw, Send, Share2, SkipBack, SkipForward, Sparkles, TrendingDown, TrendingUp, Volume2 } from "lucide-react";
import type { Brief, Lang, VoiceAnswer } from "@/modules/ai/brief-core";
import { shareText } from "@/modules/ai/brief-core";
import * as sp from "./speech";

export type BriefPayload = Brief & { generatedAt: string | Date; voice: { natural: boolean; name: "gemini" | "browser" } };
export type HistoryRow = { ymd: string; revenue: number; seen: number; listened: boolean };
type Msg = { who: "you" | "elister"; text: string; href?: string; source?: string; lang: Lang };
type Mode = "idle" | "playing" | "paused" | "listening" | "thinking" | "answering";

const ML_FONT = { fontFamily: "var(--font-ml), var(--font-poppins), system-ui, sans-serif" };
const L = (lang: Lang, en: string, ml: string) => (lang === "ml" ? ml : en);

/**
 * The owner's daily brief: plays the 3-minute summary chapter by chapter, then turns into a two-way voice conversation.
 * Hands-free mode keeps the mic open after each answer so the owner can just keep talking.
 */
export function BriefPlayer({ initial, history: initialHistory }: { initial: BriefPayload; history: HistoryRow[] }) {
  const [brief, setBrief] = useState(initial);
  const [history, setHistory] = useState(initialHistory);
  const [lang, setLang] = useState<Lang>(initial.lang);
  const [mode, setMode] = useState<Mode>("idle");
  const [chapter, setChapter] = useState(0);
  const [rate, setRate] = useState(1);
  const [handsFree, setHandsFree] = useState(false);
  const [partial, setPartial] = useState("");
  const [typed, setTyped] = useState("");
  const [showType, setShowType] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [follow, setFollow] = useState<string[]>(initial.suggestions);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [listenOk, setListenOk] = useState(true);
  const playing = useRef(false);
  const told = useRef(false);
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => { setListenOk(sp.canListen()); return () => { sp.stop(); sp.stopListening(); }; }, []);
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [msgs, partial]);
  useEffect(() => {
    if (brief.voice.natural) return;
    void sp.voicesReady().then(() => {
      if (lang === "ml" && !sp.deviceHas("ml")) setNotice("This device has no Malayalam voice installed, so the brief is shown as text. Edge (Windows/Mac) and Android include one; or ask your admin to turn on the natural voice.");
      else setNotice(null);
    });
  }, [lang, brief.voice.natural]);

  const load = useCallback(async (l: Lang, refresh = false) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/ai/brief?lang=${l}${refresh ? "&refresh=1" : ""}`, { cache: "no-store" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not load the brief");
      const j = (await r.json()) as { brief: BriefPayload; history: HistoryRow[] };
      setBrief(j.brief); setHistory(j.history); setFollow(j.brief.suggestions); setChapter(0);
    } catch (e) { setNotice((e as Error).message); } finally { setLoading(false); }
  }, []);

  const switchLang = useCallback(async (l: Lang) => { sp.stop(); playing.current = false; setMode("idle"); setLang(l); await load(l); }, [load]);

  // ------------------------------------------------ playback
  const playFrom = useCallback(async (start: number) => {
    playing.current = true; setMode("playing");
    if (!told.current) { told.current = true; void fetch("/api/ai/brief/listened", { method: "POST" }).catch(() => null); }
    for (let i = start; i < brief.sections.length; i++) {
      if (!playing.current) return;
      setChapter(i);
      if (brief.sections[i + 1]) sp.prefetch(brief.sections[i + 1].text, brief.lang, brief.voice.natural);
      const r = await sp.speak(brief.sections[i].text, brief.lang, { natural: brief.voice.natural, rate });
      if (r === "cancelled") return;
    }
    playing.current = false; setMode("idle");
    if (handsFree && listenOk) void ask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief, rate, handsFree, listenOk]);

  const toggle = () => {
    if (mode === "playing") { playing.current = false; sp.stop(); setMode("paused"); }
    else void playFrom(mode === "paused" ? chapter : chapter >= brief.sections.length - 1 ? 0 : chapter);
  };
  const jump = (i: number) => { sp.stop(); void playFrom(Math.max(0, Math.min(brief.sections.length - 1, i))); };

  // ------------------------------------------------ conversation
  const answer = useCallback(async (q: string) => {
    if (!q.trim()) { setMode("idle"); return; }
    setMsgs((m) => [...m, { who: "you", text: q, lang }]);
    setMode("thinking"); setPartial("");
    try {
      const r = await fetch("/api/ai/brief/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q, lang }) });
      const a = (await r.json()) as VoiceAnswer & { source: string; error?: string };
      if (!r.ok) throw new Error(a.error ?? "Something went wrong");
      const replyLang: Lang = /[ഀ-ൿ]/.test(a.answer) ? "ml" : "en";
      setMsgs((m) => [...m, { who: "elister", text: a.answer, href: a.href, source: a.source, lang: replyLang }]);
      setFollow(a.followUps);
      if (a.switchLang && a.switchLang !== lang) { setLang(a.switchLang); void load(a.switchLang); }
      setMode("answering");
      const res = await sp.speak(a.answer, replyLang, { natural: brief.voice.natural, rate });
      if (res === "cancelled") return;
      setMode("idle");
      if (handsFree && listenOk && a.intent !== "thanks") void ask();
    } catch (e) { setMsgs((m) => [...m, { who: "elister", text: (e as Error).message, lang: "en" }]); setMode("idle"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, brief.voice.natural, rate, handsFree, listenOk, load]);

  const ask = useCallback(async () => {
    playing.current = false; sp.stop();
    if (!listenOk) { setShowType(true); return; }
    setMode("listening"); setPartial("");
    try { const q = await sp.listen(lang, setPartial); await answer(q); }
    catch (e) {
      setMode("idle");
      setNotice((e as Error).message === "not-allowed" ? "Microphone access was blocked. Allow it in the browser's address bar, or type your question." : `Couldn't hear that (${(e as Error).message}). You can type instead.`);
      setShowType(true);
    }
  }, [lang, listenOk, answer]);

  const micClick = () => { if (mode === "listening") { sp.stopListening(); setMode("idle"); } else void ask(); };

  const share = async () => {
    const t = shareText(brief);
    try { await navigator.clipboard.writeText(t); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* ignore */ }
  };

  const issues = brief.alerts.filter((a) => a.level !== "good");
  const progress = brief.sections.length ? ((chapter + (mode === "idle" && chapter === brief.sections.length - 1 ? 1 : 0.5)) / brief.sections.length) * 100 : 0;
  const maxRev = Math.max(1, ...history.map((h) => h.revenue));
  const font = lang === "ml" ? ML_FONT : undefined;
  const status = useMemo(() => ({
    idle: L(lang, "Ready", "തയ്യാർ"), playing: L(lang, "Speaking", "സംസാരിക്കുന്നു"), paused: L(lang, "Paused", "നിർത്തി"),
    listening: L(lang, "Listening…", "കേൾക്കുന്നു…"), thinking: L(lang, "Thinking…", "ആലോചിക്കുന്നു…"), answering: L(lang, "Answering", "മറുപടി"),
  })[mode], [mode, lang]);

  return (
    <div className="space-y-5" style={font}>
      {/* ---------------- hero player ---------------- */}
      <section className="brief-hero page-in relative overflow-hidden rounded-3xl p-5 text-white md:p-7">
        <span aria-hidden className="brief-glow" />
        <div className="relative grid gap-6 lg:grid-cols-[auto_1fr] lg:items-center">
          <button onClick={toggle} aria-label={mode === "playing" ? "Pause brief" : "Play brief"} className={`brief-orb mx-auto ${mode === "playing" || mode === "answering" ? "is-speaking" : ""} ${mode === "listening" ? "is-listening" : ""} ${mode === "thinking" ? "is-thinking" : ""}`}>
            <span className="brief-orb-ring" /><span className="brief-orb-ring r2" /><span className="brief-orb-ring r3" />
            <span className="brief-orb-core">{mode === "playing" ? <Pause size={34} /> : <Play size={34} className="ms-1" />}</span>
          </button>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 font-semibold uppercase tracking-widest"><Sparkles size={12} />{L(lang, "AI personal assistant", "AI പേഴ്സണൽ അസിസ്റ്റന്റ്")}</span>
              <span className="rounded-full bg-white/10 px-2.5 py-1">{status}</span>
              <span className="rounded-full bg-white/10 px-2.5 py-1">~{Math.max(1, Math.round(brief.seconds / 60))} {L(lang, "min", "മിനിറ്റ്")}</span>
              <span className="rounded-full bg-white/10 px-2.5 py-1" title={brief.voice.natural ? "Natural voice via Google Gemini (aggregate figures only)" : "Your device's built-in voice. Nothing leaves Elister."}><Volume2 size={11} className="me-1 inline" />{brief.voice.natural ? L(lang, "Natural voice", "സ്വാഭാവിക ശബ്ദം") : L(lang, "Device voice · on-premise", "ഉപകരണ ശബ്ദം")}</span>
            </div>
            <h1 className="mt-2 text-2xl font-semibold leading-tight md:text-3xl">{brief.title}</h1>
            <p className="mt-1 text-sm text-white/75">{new Date(`${brief.ymd}T08:00:00+04:00`).toLocaleDateString(lang === "ml" ? "ml-IN" : "en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Dubai" })} · {L(lang, "updated", "പുതുക്കിയത്")} {new Date(brief.generatedAt).toLocaleTimeString("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" })}</p>

            {/* chapters */}
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/15"><div className="h-full rounded-full bg-white transition-[width] duration-700" style={{ width: `${Math.min(100, progress)}%` }} /></div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {brief.sections.map((s, i) => (
                <button key={s.key} onClick={() => jump(i)} className={`rounded-full px-3 py-1 text-xs transition ${i === chapter && mode !== "idle" ? "bg-white font-semibold text-[#0b3558]" : "bg-white/12 text-white/85 hover:bg-white/25"}`}>{s.title}</button>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button onClick={() => jump(chapter - 1)} className="brief-ctl" aria-label="Previous chapter"><SkipBack size={16} /></button>
              <button onClick={toggle} className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-[#0b3558] shadow-lg transition hover:-translate-y-0.5">
                {mode === "playing" ? <><Pause size={16} />{L(lang, "Pause", "നിർത്തുക")}</> : <><Play size={16} />{mode === "paused" ? L(lang, "Resume", "തുടരുക") : L(lang, "Play my brief", "ബ്രീഫ് കേൾക്കുക")}</>}
              </button>
              <button onClick={() => jump(chapter + 1)} className="brief-ctl" aria-label="Next chapter"><SkipForward size={16} /></button>
              <button onClick={() => setRate((r) => (r === 1 ? 1.2 : r === 1.2 ? 0.9 : 1))} className="brief-ctl w-auto px-3 text-xs font-semibold" aria-label="Playback speed"><Gauge size={14} className="me-1" />{rate}×</button>
              <div className="ms-auto flex rounded-xl bg-white/12 p-1 text-xs font-semibold" role="radiogroup" aria-label="Language">
                {(["en", "ml"] as Lang[]).map((l) => <button key={l} role="radio" aria-checked={lang === l} onClick={() => lang !== l && void switchLang(l)} className={`rounded-lg px-3 py-1.5 transition ${lang === l ? "bg-white text-[#0b3558]" : "text-white/85 hover:bg-white/15"}`} style={l === "ml" ? ML_FONT : undefined}>{l === "en" ? "English" : "മലയാളം"}</button>)}
              </div>
            </div>
          </div>
        </div>
        {/* now-speaking caption */}
        <p className={`relative mt-5 min-h-12 rounded-2xl bg-black/15 p-4 text-[15px] leading-relaxed text-white/95 backdrop-blur transition ${loading ? "opacity-50" : ""}`} aria-live="polite">{brief.sections[chapter]?.text}</p>
      </section>

      {notice && <div className="flex items-start gap-2 rounded-2xl border border-warn/30 bg-warn/10 p-3 text-sm"><AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn" /><span className="flex-1">{notice}</span><button onClick={() => setNotice(null)} className="text-xs text-muted">✕</button></div>}

      {/* ---------------- KPIs ---------------- */}
      <section className="stagger grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {brief.kpis.map((k) => {
          const good = k.deltaPct === null ? null : (k.deltaPct >= 0) === (k.goodWhen === "up");
          return (
            <div key={k.key} className="rounded-2xl border border-border bg-surface p-4 shadow-card">
              <div className="text-xs text-muted">{k.label}</div>
              <div className="mt-1 text-xl font-semibold tabular-nums">{k.value}</div>
              {k.deltaPct !== null && <div className={`mt-1 inline-flex items-center gap-1 text-xs font-semibold ${good ? "text-ok" : "text-danger"}`}>{k.deltaPct >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}{Math.abs(Math.round(k.deltaPct))}%</div>}
            </div>
          );
        })}
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* ---------------- conversation ---------------- */}
        <section className="flex min-h-[420px] flex-col rounded-3xl border border-border bg-surface shadow-card">
          <header className="flex items-center gap-3 border-b border-border px-5 py-4">
            <div className="flex-1"><h2 className="font-semibold">{L(lang, "Talk to Elister", "എലിസ്റ്ററിനോട് സംസാരിക്കൂ")}</h2><p className="text-xs text-muted">{L(lang, "Ask a follow-up by voice or text. Answers come from your own figures.", "ശബ്ദത്തിലോ ടൈപ്പ് ചെയ്തോ ചോദിക്കാം. ഉത്തരങ്ങൾ നിങ്ങളുടെ കണക്കുകളിൽ നിന്ന്.")}</p></div>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted" title="Keep listening after each answer"><input type="checkbox" checked={handsFree} onChange={(e) => setHandsFree(e.target.checked)} className="accent-[var(--primary)]" />{L(lang, "Hands-free", "ഹാൻഡ്സ്-ഫ്രീ")}</label>
          </header>
          <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4" style={{ maxHeight: 460 }}>
            {msgs.length === 0 && <p className="py-6 text-center text-sm text-muted">{L(lang, "Tap the microphone and ask, for example:", "മൈക്ക് അമർത്തി ചോദിക്കൂ, ഉദാഹരണത്തിന്:")}</p>}
            {msgs.map((m, i) => (
              <div key={i} className={`flex ${m.who === "you" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${m.who === "you" ? "bg-primary text-primary-fg" : "bg-surface-2"}`} style={m.lang === "ml" ? ML_FONT : undefined}>
                  {m.text}
                  {m.who === "elister" && (m.href || m.source) && <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted">{m.source && m.source !== "none" && <span>{m.source === "brief" ? "from today's brief" : m.source === "books" ? "from the books" : "AI answer from today's figures"}</span>}{m.href && <Link href={m.href} className="inline-flex items-center gap-0.5 font-medium text-primary">Open<ArrowUpRight size={11} /></Link>}</div>}
                </div>
              </div>
            ))}
            {mode === "listening" && <div className="flex justify-end"><div className="rounded-2xl bg-primary/15 px-4 py-2.5 text-sm italic">{partial || L(lang, "Listening…", "കേൾക്കുന്നു…")}</div></div>}
            {mode === "thinking" && <div className="flex gap-1 px-2"><span className="brief-dot" /><span className="brief-dot d2" /><span className="brief-dot d3" /></div>}
            <div ref={chatEnd} />
          </div>
          <div className="flex flex-wrap gap-1.5 px-5 pb-3">
            {follow.map((q) => <button key={q} onClick={() => void answer(q)} disabled={mode === "thinking"} className="rounded-full border border-border px-3 py-1.5 text-xs transition hover:border-primary hover:text-primary" style={/[ഀ-ൿ]/.test(q) ? ML_FONT : undefined}>{q}</button>)}
          </div>
          <footer className="flex items-center gap-2 border-t border-border p-3">
            <button onClick={micClick} disabled={!listenOk && !showType} className={`brief-mic ${mode === "listening" ? "is-on" : ""}`} aria-label={mode === "listening" ? "Stop listening" : "Ask by voice"}>{mode === "listening" ? <MicOff size={20} /> : <Mic size={20} />}</button>
            {showType || !listenOk ? (
              <form className="flex flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); const q = typed; setTyped(""); void answer(q); }}>
                <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={L(lang, "Type a question…", "ചോദ്യം ടൈപ്പ് ചെയ്യൂ…")} className="flex-1 rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-primary" />
                <button className="grid size-10 place-items-center rounded-xl bg-primary text-primary-fg" aria-label="Send"><Send size={16} /></button>
              </form>
            ) : (
              <button onClick={() => setShowType(true)} className="flex flex-1 items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2.5 text-sm text-muted"><Keyboard size={15} />{mode === "listening" ? L(lang, "Speak now — tap the mic to stop", "ഇപ്പോൾ സംസാരിക്കൂ") : L(lang, "Tap the mic and speak, or type here", "മൈക്ക് അമർത്തി സംസാരിക്കൂ, അല്ലെങ്കിൽ ടൈപ്പ് ചെയ്യൂ")}</button>
            )}
          </footer>
        </section>

        {/* ---------------- side column ---------------- */}
        <aside className="space-y-5">
          <section className="rounded-3xl border border-border bg-surface p-5 shadow-card">
            <h2 className="flex items-center gap-2 font-semibold">{L(lang, "Needs your attention", "ശ്രദ്ധിക്കേണ്ടവ")}{issues.length > 0 && <span className="rounded-full bg-danger/15 px-2 text-xs text-danger">{issues.length}</span>}</h2>
            <ul className="mt-3 space-y-2">
              {brief.alerts.length === 0 && <li className="text-sm text-muted">{L(lang, "All clear today.", "ഇന്ന് എല്ലാം ശരിയാണ്.")}</li>}
              {brief.alerts.map((a) => (
                <li key={a.key}><Link href={a.href} className={`block rounded-2xl border-s-4 p-3 text-sm transition hover:bg-surface-2 ${a.level === "critical" ? "border-danger bg-danger/5" : a.level === "warn" ? "border-warn bg-warn/5" : "border-ok bg-ok/5"}`}>{a.level === "good" ? <Check size={14} className="me-1 inline text-ok" /> : <AlertTriangle size={14} className={`me-1 inline ${a.level === "critical" ? "text-danger" : "text-warn"}`} />}{a.text}</Link></li>
              ))}
            </ul>
          </section>

          <section className="rounded-3xl border border-border bg-surface p-5 shadow-card">
            <h2 className="font-semibold">{L(lang, "Last 14 briefs", "കഴിഞ്ഞ 14 ബ്രീഫുകൾ")}</h2>
            <p className="text-xs text-muted">{L(lang, "Daily revenue; dot = you listened", "ദൈനംദിന വരുമാനം; പുള്ളി = കേട്ടു")}</p>
            <div className="mt-3 flex h-24 items-end gap-1">
              {[...history].reverse().map((h) => (
                <div key={h.ymd} className="group relative flex flex-1 flex-col items-center justify-end gap-1" title={`${h.ymd}: AED ${Math.round(h.revenue).toLocaleString("en-US")} · ${h.seen} patients`}>
                  <div className="brief-bar w-full rounded-t-md bg-primary/70 transition group-hover:bg-primary" style={{ height: `${Math.max(4, (h.revenue / maxRev) * 80)}px` }} />
                  <span className={`size-1.5 rounded-full ${h.listened ? "bg-ok" : "bg-border"}`} />
                </div>
              ))}
              {history.length === 0 && <p className="text-sm text-muted">{L(lang, "History builds up from tomorrow.", "നാളെ മുതൽ ചരിത്രം കാണാം.")}</p>}
            </div>
          </section>

          <section className="rounded-3xl border border-border bg-surface p-5 shadow-card">
            <h2 className="font-semibold">{L(lang, "Share with partners", "പങ്കാളികളുമായി പങ്കിടുക")}</h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <a href={`https://wa.me/?text=${encodeURIComponent(shareText(brief))}`} target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#25D366] px-3 py-2.5 text-sm font-semibold text-white"><Share2 size={15} />WhatsApp</a>
              <button onClick={() => void share()} className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-border px-3 py-2.5 text-sm font-medium">{copied ? <><Check size={15} />{L(lang, "Copied", "പകർത്തി")}</> : <><Copy size={15} />{L(lang, "Copy text", "പകർത്തുക")}</>}</button>
            </div>
            <button onClick={() => void load(lang, true)} disabled={loading} className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs text-muted transition hover:text-fg"><RefreshCw size={13} className={loading ? "animate-spin" : ""} />{L(lang, "Rebuild with latest figures", "പുതിയ കണക്കുകളോടെ പുതുക്കുക")}</button>
          </section>

          <details className="rounded-3xl border border-border bg-surface p-5 text-sm shadow-card">
            <summary className="cursor-pointer font-semibold">{L(lang, "Full transcript", "പൂർണ്ണ രൂപം")}</summary>
            <div className="mt-3 space-y-3 leading-relaxed text-muted">{brief.sections.map((s) => <p key={s.key}><span className="font-semibold text-fg">{s.title}. </span>{s.text}</p>)}</div>
          </details>
        </aside>
      </div>
    </div>
  );
}
