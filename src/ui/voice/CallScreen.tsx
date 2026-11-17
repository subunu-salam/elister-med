"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { FileText, Keyboard, Mic, MicOff, Pause, Phone, PhoneOff, Play, Send, SkipForward, Volume2 } from "lucide-react";
import type { Brief, Lang, VoiceAnswer } from "@/modules/ai/brief-core";
import * as sp from "./speech";
import { chime, startRingtone, stopRingtone } from "./ringtone";

export type CallBrief = Brief & { voice: { natural: boolean } };
type Phase = "ringing" | "report" | "paused" | "listening" | "thinking" | "replying" | "tap" | "ended";
type Line = { who: "elister" | "you"; text: string; lang: Lang; href?: string };

const ML_FONT = { fontFamily: "var(--font-ml), var(--font-poppins), system-ui, sans-serif" };
const L = (l: Lang, en: string, ml: string) => (l === "ml" ? ml : en);
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

/**
 * The assistant's phone call. Rings (unless it was answered from the notification), then Elister reads the day's report chapter by
 * chapter, asks "is there anything else?", and from then on it is a two-way voice conversation until the owner says they are done or
 * hangs up. Captions and a transcript run alongside, and the full written report stays one tap away.
 */
export function CallScreen({ initial, answered, name }: { initial: CallBrief; answered: boolean; name: string }) {
  const router = useRouter();
  const [brief, setBrief] = useState(initial);
  const [lang, setLang] = useState<Lang>(initial.lang);
  const [phase, setPhase] = useState<Phase>(answered ? "tap" : "ringing");
  const [chapter, setChapter] = useState(0);
  const [caption, setCaption] = useState("");
  const [partial, setPartial] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [secs, setSecs] = useState(0);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [follow, setFollow] = useState<string[]>(initial.suggestions);
  const [canListen, setCanListen] = useState(true);
  const live = useRef(true);
  const misses = useRef(0);
  const started = useRef<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setCanListen(sp.canListen()); return () => { live.current = false; sp.stop(); sp.stopListening(); stopRingtone(); }; }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [lines, partial]);
  useEffect(() => {
    if (phase === "ringing") { void startRingtone(); return () => stopRingtone(); }
  }, [phase]);
  useEffect(() => {
    if (phase === "ringing" || phase === "tap" || phase === "ended") return;
    const t = setInterval(() => setSecs(started.current ? Math.floor((Date.now() - started.current) / 1000) : 0), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const say = useCallback(async (text: string, l: Lang): Promise<boolean> => {
    setCaption(text);
    const r = await sp.speak(text, l, { natural: brief.voice.natural });
    if (r === "blocked") { setPhase("tap"); return false; }
    return r !== "cancelled" && live.current;
  }, [brief.voice.natural]);

  const hangUp = useCallback((why: "user" | "done" = "user") => {
    live.current = false; sp.stop(); sp.stopListening(); stopRingtone();
    void chime("end");
    setPhase("ended"); setCaption(why === "done" ? "" : L(lang, "Call ended.", "കോൾ അവസാനിച്ചു."));
  }, [lang]);

  // ------------------------------------------------ conversation loop
  const ask = useCallback(async (q: string) => {
    setLines((x) => [...x, { who: "you", text: q, lang: /[ഀ-ൿ]/.test(q) ? "ml" : lang }]);
    setPhase("thinking"); setPartial("");
    let a: VoiceAnswer & { error?: string };
    try {
      const r = await fetch("/api/ai/brief/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q, lang }) });
      a = await r.json();
      if (!r.ok) throw new Error(a.error);
    } catch { a = { intent: "unknown", answer: L(lang, "Sorry, I lost the connection for a moment. Could you say that again?", "ക്ഷമിക്കണം, ഒരു നിമിഷം കണക്ഷൻ പോയി. ഒന്നുകൂടി പറയാമോ?"), followUps: follow, handled: false }; }
    const l: Lang = /[ഀ-ൿ]/.test(a.answer) ? "ml" : "en";
    if (a.switchLang) setLang(a.switchLang);
    setLines((x) => [...x, { who: "elister", text: a.answer, lang: l, href: a.href }]);
    setFollow(a.followUps);
    setPhase("replying");
    const ok = await say(a.answer, l);
    if (!ok) return;
    if (a.end) { hangUp("done"); return; }
    void listenLoop(a.switchLang ?? lang);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, follow, say, hangUp]);

  const listenLoop = useCallback(async (l: Lang) => {
    if (!live.current) return;
    if (!canListen) { setTyping(true); setPhase("listening"); return; }
    setPhase("listening"); setPartial("");
    let q = "";
    try { q = await sp.listen(l, setPartial); } catch { setTyping(true); return; }
    if (!live.current) return;
    if (!q) {
      misses.current++;
      if (misses.current >= 2) {
        setLines((x) => [...x, { who: "elister", text: L(l, "I'll let you go. Your full report is saved in Elister.", "ശരി, പൂർണ്ണ റിപ്പോർട്ട് എലിസ്റ്ററിൽ സേവ് ചെയ്തിട്ടുണ്ട്."), lang: l }]);
        await say(L(l, "I'll let you go. Your full report is saved in Elister. Goodbye.", "ശരി, പൂർണ്ണ റിപ്പോർട്ട് എലിസ്റ്ററിൽ സേവ് ചെയ്തിട്ടുണ്ട്. നന്ദി."), l);
        hangUp("done"); return;
      }
      setPhase("replying");
      if (await say(L(l, "Sorry, I didn't catch that. Is there anything else you'd like to know?", "ക്ഷമിക്കണം, കേട്ടില്ല. മറ്റെന്തെങ്കിലും അറിയണോ?"), l)) void listenLoop(l);
      return;
    }
    misses.current = 0;
    void ask(q);
  }, [canListen, ask, say, hangUp]);

  // ------------------------------------------------ the report
  const playReport = useCallback(async (from = 0) => {
    for (let i = from; i < brief.sections.length; i++) {
      if (!live.current) return;
      setChapter(i); setPhase("report");
      const s = brief.sections[i];
      if (brief.sections[i + 1]) sp.prefetch(brief.sections[i + 1].text, brief.lang, brief.voice.natural);
      if (i === brief.sections.length - 1) setLines((x) => [...x, { who: "elister", text: s.text, lang: brief.lang }]);
      if (!(await say(s.text, brief.lang))) return;
    }
    void listenLoop(lang);
  }, [brief, say, listenLoop, lang]);

  const connect = useCallback(async () => {
    sp.unlock(); stopRingtone();
    started.current = started.current ?? Date.now();
    live.current = true;
    void fetch("/api/ai/call/answer", { method: "POST" }).catch(() => null);
    await chime("connect");
    await new Promise((r) => setTimeout(r, 450));
    void playReport(chapter);
  }, [playReport, chapter]);

  // Answered from the notification: try to start straight away; if the browser wants a tap first, the "tap" phase asks for it.
  useEffect(() => { if (answered) void connect(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const decline = () => { stopRingtone(); void fetch("/api/ai/call/decline", { method: "POST" }).catch(() => null); router.push("/dashboard"); };
  const pause = () => { if (phase === "report") { sp.stop(); setPhase("paused"); } else if (phase === "paused") void playReport(chapter); };
  const skipToQuestions = () => { sp.stop(); setChapter(brief.sections.length - 1); void (async () => { if (await say(brief.sections.at(-1)!.text, brief.lang)) void listenLoop(lang); })(); };
  const switchLang = async (l: Lang) => {
    sp.stop(); setLang(l);
    const r = await fetch(`/api/ai/brief?lang=${l}`, { cache: "no-store" });
    if (r.ok) { const j = await r.json(); setBrief(j.brief); setFollow(j.brief.suggestions); if (phase === "report" || phase === "paused") { live.current = true; setTimeout(() => void playReport(chapter), 50); } }
  };
  const micToggle = () => { if (phase === "listening") { sp.stopListening(); setTyping(true); } else { sp.stop(); void listenLoop(lang); } };

  const speaking = phase === "report" || phase === "replying";
  const font = lang === "ml" ? ML_FONT : undefined;

  // Drawn straight into <body>: inside the app shell an ancestor's animation/transform would trap a fixed layer under the page.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = ""; }; }, []);
  if (!mounted) return null;

  return createPortal(
    <div className="call-screen" style={font}>
      <div className="call-bg" aria-hidden />
      <div className="relative z-10 mx-auto flex min-h-[calc(100dvh-2rem)] max-w-3xl flex-col px-4 py-6 text-white">
        {/* header */}
        <div className="flex items-center justify-between text-xs text-white/70">
          <span className="inline-flex items-center gap-1.5"><span className={`size-2 rounded-full ${phase === "ended" ? "bg-white/40" : phase === "ringing" ? "animate-pulse bg-amber-300" : "bg-emerald-400"}`} />{phase === "ringing" ? L(lang, "Incoming call", "ഇൻകമിംഗ് കോൾ") : phase === "ended" ? L(lang, "Call ended", "കോൾ അവസാനിച്ചു") : mmss(secs)}</span>
          <div className="flex rounded-full bg-white/10 p-0.5" role="radiogroup" aria-label="Language">
            {(["en", "ml"] as Lang[]).map((l) => <button key={l} role="radio" aria-checked={lang === l} onClick={() => lang !== l && void switchLang(l)} className={`rounded-full px-3 py-1 font-semibold ${lang === l ? "bg-white text-[#0b3558]" : ""}`} style={l === "ml" ? ML_FONT : undefined}>{l === "en" ? "EN" : "മല"}</button>)}
          </div>
        </div>

        {/* caller */}
        <div className="mt-8 flex flex-col items-center text-center">
          <div className={`call-avatar ${phase === "ringing" ? "is-ringing" : speaking ? "is-speaking" : phase === "listening" ? "is-listening" : phase === "thinking" ? "is-thinking" : ""}`}>
            <span className="call-avatar-core">E</span><span className="call-wave" /><span className="call-wave w2" /><span className="call-wave w3" />
          </div>
          <h1 className="mt-6 text-2xl font-semibold">Elister AI</h1>
          <p className="text-sm text-white/70">{L(lang, `Personal assistant to ${name}`, `${name}-ന്റെ പേഴ്സണൽ അസിസ്റ്റന്റ്`)}</p>
          <p className="mt-1 text-xs text-white/50">{phase === "listening" ? L(lang, "Listening…", "കേൾക്കുന്നു…") : phase === "thinking" ? L(lang, "Thinking…", "ആലോചിക്കുന്നു…") : speaking ? `${brief.title} · ${brief.sections[chapter]?.title ?? ""}` : phase === "ringing" ? brief.title : ""}</p>
        </div>

        {/* chapters */}
        {phase !== "ringing" && phase !== "ended" && (
          <div className="mt-5 flex justify-center gap-1">{brief.sections.map((s, i) => <span key={s.key} title={s.title} className={`h-1 rounded-full transition-all ${i < chapter ? "w-6 bg-white/70" : i === chapter && (phase === "report" || phase === "paused") ? "w-10 bg-white" : "w-6 bg-white/20"}`} />)}</div>
        )}

        {/* caption / live words */}
        <div className="mt-6 min-h-24 rounded-3xl bg-black/20 p-5 text-center text-[17px] leading-relaxed backdrop-blur" aria-live="polite">
          {phase === "listening" ? <span className="italic text-white/80">{partial || L(lang, "Go ahead, I'm listening…", "പറഞ്ഞോളൂ, ഞാൻ കേൾക്കുന്നു…")}</span>
            : phase === "ringing" ? <span className="text-white/80">{L(lang, "Your personal AI assistant is calling with today's summary.", "നിങ്ങളുടെ പേഴ്സണൽ AI അസിസ്റ്റന്റ് ഇന്നത്തെ സംഗ്രഹവുമായി വിളിക്കുന്നു.")}</span>
            : phase === "tap" ? <button onClick={() => void connect()} className="mx-auto inline-flex items-center gap-2 rounded-2xl bg-white px-5 py-3 font-semibold text-[#0b3558]"><Volume2 size={18} />{L(lang, "Tap to hear Elister", "കേൾക്കാൻ ടാപ്പ് ചെയ്യുക")}</button>
            : caption}
        </div>

        {/* transcript of the conversation part */}
        {lines.length > 0 && (
          <div className="mt-4 max-h-64 space-y-2 overflow-y-auto pe-1">
            {lines.map((m, i) => (
              <div key={i} className={`flex ${m.who === "you" ? "justify-end" : ""}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${m.who === "you" ? "bg-white text-[#0b3558]" : "bg-white/10"}`} style={m.lang === "ml" ? ML_FONT : undefined}>{m.text}{m.href && <Link href={m.href} className="ms-2 text-xs underline opacity-80">open</Link>}</div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        )}

        {/* suggestions / typing */}
        {(phase === "listening" || phase === "replying") && (
          <div className="mt-3 flex flex-wrap justify-center gap-1.5">
            {follow.map((q) => <button key={q} onClick={() => { sp.stop(); sp.stopListening(); void ask(q); }} className="rounded-full bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20" style={/[ഀ-ൿ]/.test(q) ? ML_FONT : undefined}>{q}</button>)}
          </div>
        )}
        {typing && phase !== "ended" && (
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) { const q = typed; setTyped(""); sp.stopListening(); void ask(q); } }}>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus placeholder={L(lang, "Type your question…", "ചോദ്യം ടൈപ്പ് ചെയ്യൂ…")} className="flex-1 rounded-2xl bg-white/10 px-4 py-3 text-sm text-white outline-none placeholder:text-white/50 focus:bg-white/15" />
            <button className="grid size-12 place-items-center rounded-2xl bg-white text-[#0b3558]" aria-label="Send"><Send size={18} /></button>
          </form>
        )}

        <div className="flex-1" />

        {/* controls */}
        {phase === "ringing" ? (
          <div className="mb-6 mt-10 flex items-center justify-center gap-20">
            <div className="text-center"><button onClick={decline} className="call-btn bg-[#e5484d]" aria-label="Decline"><PhoneOff size={28} /></button><div className="mt-2 text-xs text-white/70">{L(lang, "Decline", "നിരസിക്കുക")}</div></div>
            <div className="text-center"><button onClick={() => void connect()} className="call-btn call-btn-answer bg-[#1fbf75]" aria-label="Answer"><Phone size={28} /></button><div className="mt-2 text-xs text-white/70">{L(lang, "Answer", "എടുക്കുക")}</div></div>
          </div>
        ) : phase === "ended" ? (
          <div className="mb-6 mt-8 space-y-3 text-center">
            <p className="text-sm text-white/70">{L(lang, `Call lasted ${mmss(secs)}. Your full report is saved.`, `കോൾ ${mmss(secs)} നീണ്ടു. പൂർണ്ണ റിപ്പോർട്ട് സേവ് ചെയ്തിട്ടുണ്ട്.`)}</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Link href="/ai/brief" className="inline-flex items-center gap-2 rounded-2xl bg-white px-5 py-3 text-sm font-semibold text-[#0b3558]"><FileText size={16} />{L(lang, "Open the full report", "പൂർണ്ണ റിപ്പോർട്ട് തുറക്കുക")}</Link>
              <button onClick={() => { setLines([]); setChapter(0); setSecs(0); started.current = null; void connect(); }} className="inline-flex items-center gap-2 rounded-2xl bg-white/10 px-5 py-3 text-sm font-semibold"><Phone size={16} />{L(lang, "Call again", "വീണ്ടും വിളിക്കുക")}</button>
            </div>
          </div>
        ) : (
          <div className="mb-6 mt-8 flex items-end justify-center gap-5">
            <CtlBtn label={phase === "paused" ? L(lang, "Resume", "തുടരുക") : L(lang, "Pause", "നിർത്തുക")} onClick={pause} disabled={phase !== "report" && phase !== "paused"}>{phase === "paused" ? <Play size={22} /> : <Pause size={22} />}</CtlBtn>
            <CtlBtn label={L(lang, "Questions", "ചോദ്യങ്ങൾ")} onClick={skipToQuestions} disabled={phase !== "report" && phase !== "paused"}><SkipForward size={22} /></CtlBtn>
            <div className="text-center"><button onClick={() => hangUp()} className="call-btn bg-[#e5484d]" aria-label="Hang up"><PhoneOff size={28} /></button><div className="mt-2 text-xs text-white/70">{L(lang, "End", "അവസാനിപ്പിക്കുക")}</div></div>
            <CtlBtn label={phase === "listening" ? L(lang, "Stop", "നിർത്തുക") : L(lang, "Speak", "സംസാരിക്കുക")} onClick={micToggle} active={phase === "listening"}>{phase === "listening" ? <MicOff size={22} /> : <Mic size={22} />}</CtlBtn>
            <CtlBtn label={L(lang, "Type", "ടൈപ്പ്")} onClick={() => setTyping((t) => !t)} active={typing}><Keyboard size={22} /></CtlBtn>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function CtlBtn({ children, label, onClick, disabled, active }: { children: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; active?: boolean }) {
  return (
    <div className="text-center">
      <button onClick={onClick} disabled={disabled} className={`grid size-14 place-items-center rounded-full transition ${active ? "bg-white text-[#0b3558]" : "bg-white/12 hover:bg-white/20"} disabled:opacity-35`} aria-label={label}>{children}</button>
      <div className="mt-2 text-[11px] text-white/70">{label}</div>
    </div>
  );
}
