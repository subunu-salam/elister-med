"use client";
/**
 * Speaking and listening for the voice brief.
 * Speaking: the natural (Gemini) voice when the server has it switched on, otherwise the device's own voices (Web Speech API).
 * Listening: the browser's speech recognition (Chrome, Edge, Safari, Android). English uses en-AE; Malayalam uses ml-IN.
 * Everything here is cancellable: start a new speak() or call stop() and anything still playing or queued is dropped.
 */
export type Lang = "en" | "ml";
const LOCALE: Record<Lang, string> = { en: "en-GB", ml: "ml-IN" };
const LISTEN: Record<Lang, string> = { en: "en-AE", ml: "ml-IN" };

let token = 0;
let audio: HTMLAudioElement | null = null;
const audioCache = new Map<string, string>();

export function stop() {
  token++;
  if (typeof window === "undefined") return;
  window.speechSynthesis?.cancel();
  if (audio) { audio.pause(); audio = null; }
}

function voices(): SpeechSynthesisVoice[] { return typeof window !== "undefined" && window.speechSynthesis ? window.speechSynthesis.getVoices() : []; }
/** Waits for the voice list, which Chrome fills in asynchronously. */
export function voicesReady(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((res) => {
    const v = voices();
    if (v.length || !window.speechSynthesis) return res(v);
    const done = () => res(voices());
    window.speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1500);
  });
}
export function deviceHas(lang: Lang): boolean { return voices().some((v) => v.lang.toLowerCase().startsWith(lang)); }

function pickVoice(lang: Lang): SpeechSynthesisVoice | undefined {
  const v = voices().filter((x) => x.lang.toLowerCase().startsWith(lang));
  const score = (x: SpeechSynthesisVoice) => (/natural|neural|online/i.test(x.name) ? 4 : 0) + (/google/i.test(x.name) ? 2 : 0) + (/en-gb|en-in|ml-in/i.test(x.lang) ? 1 : 0);
  return v.sort((a, b) => score(b) - score(a))[0];
}

/** Chrome stops long utterances after ~15 s, so speak sentence by sentence. */
const sentences = (t: string) => t.match(/[^.!?。]+[.!?。]?/g)?.map((s) => s.trim()).filter(Boolean) ?? [t];

async function speakDevice(text: string, lang: Lang, rate: number, my: number) {
  await voicesReady();
  const voice = pickVoice(lang);
  for (const s of sentences(text)) {
    if (my !== token) return;
    await new Promise<void>((res) => {
      const u = new SpeechSynthesisUtterance(s);
      u.lang = voice?.lang ?? LOCALE[lang]; if (voice) u.voice = voice;
      u.rate = rate * (lang === "ml" ? 0.95 : 1); u.pitch = 1;
      u.onend = () => res(); u.onerror = () => res();
      window.speechSynthesis.speak(u);
    });
  }
}

async function fetchNatural(text: string, lang: Lang): Promise<string | null> {
  const k = `${lang}:${text}`;
  if (audioCache.has(k)) return audioCache.get(k)!;
  const r = await fetch("/api/ai/brief/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, lang }) });
  if (r.status !== 200) return null;
  const url = URL.createObjectURL(await r.blob());
  audioCache.set(k, url);
  return url;
}
/** Starts synthesising the next section while the current one plays, so there is no gap between sections. */
export function prefetch(text: string, lang: Lang, natural: boolean) { if (natural) void fetchNatural(text, lang).catch(() => null); }

/** Speaks text; resolves when finished or cancelled. Returns "natural" | "device" | "cancelled". */
export async function speak(text: string, lang: Lang, opts: { natural: boolean; rate?: number; onLevel?: (v: number) => void }): Promise<"natural" | "device" | "cancelled"> {
  stop();
  const my = token;
  const rate = opts.rate ?? 1;
  if (opts.natural) {
    const url = await fetchNatural(text, lang).catch(() => null);
    if (my !== token) return "cancelled";
    if (url) {
      await new Promise<void>((res) => {
        const a = new Audio(url); audio = a; a.playbackRate = rate;
        a.onended = () => res(); a.onerror = () => res(); a.onpause = () => res();
        a.play().catch(() => res());
      });
      return my === token ? "natural" : "cancelled";
    }
  }
  if (!window.speechSynthesis) return "cancelled";
  await speakDevice(text, lang, rate, my);
  return my === token ? "device" : "cancelled";
}

// ---------------------------------------------------------------- listening

type Rec = { lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number; start(): void; stop(): void; abort(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null };
type RecCtor = new () => Rec;
const Ctor = (): RecCtor | undefined => typeof window === "undefined" ? undefined : ((window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: RecCtor }).webkitSpeechRecognition);
export const canListen = () => !!Ctor();

let current: Rec | null = null;
export function stopListening() { current?.abort(); current = null; }

/** Listens for one question. onPartial shows words as they are heard; resolves with the final text ("" if nothing was heard). */
export function listen(lang: Lang, onPartial: (t: string) => void): Promise<string> {
  stop();
  const C = Ctor();
  if (!C) return Promise.reject(new Error("unsupported"));
  stopListening();
  return new Promise((res, rej) => {
    const r = new C(); current = r;
    r.lang = LISTEN[lang]; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
    let finalText = "";
    r.onresult = (e) => {
      let interim = "";
      for (let i = 0; i < e.results.length; i++) { const x = e.results[i]; if (x.isFinal) finalText = x[0].transcript; else interim += x[0].transcript; }
      onPartial(finalText || interim);
    };
    r.onerror = (e) => { if (e.error === "no-speech" || e.error === "aborted") res(""); else rej(new Error(e.error)); };
    r.onend = () => { current = null; res(finalText.trim()); };
    r.start();
  });
}
