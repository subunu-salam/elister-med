import "server-only";
import { AppError } from "@/core/errors";
import type { Ctx } from "@/core/rbac/authorize";
import { callOpening, composeBrief, firstName, type Lang } from "./brief-core";
import { assertBrief, getFacts, getPrefs } from "./brief";
import { geminiKey, liveEnabled } from "./voice-provider";
import { DEFAULT_TZ } from "./schedule-core";

/**
 * Live two-way voice for the assistant's call: Gemini Live, the same engine VoiceBite and Local Link use.
 * The browser streams the microphone straight to Gemini and plays the answer as it is spoken (about a second after the owner stops,
 * and the owner can interrupt). The API key stays here: the browser gets a one-use token that expires in minutes.
 *
 * On when GEMINI_API_KEY is set (switch off with ELISTER_LIVE=0). What Gemini receives: the day's report and its aggregate figures,
 * the owner's first name, and the names of doctors, insurers and corporate clients. Never patient names or clinical data.
 *
 *   GEMINI_LIVE_MODEL  default gemini-3.8-live (as VoiceBite / Local Link)
 *   GEMINI_VOICE       default Kore (GEMINI_VOICE_ML / GEMINI_VOICE_EN per language)
 */
const liveModel = () => process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live";
const voiceFor = (lang: Lang) => (lang === "ml" ? process.env.GEMINI_VOICE_ML : process.env.GEMINI_VOICE_EN) || process.env.GEMINI_VOICE || "Kore";

async function liveToken(): Promise<string> {
  const now = Date.now();
  const r = await fetch("https://generativelanguage.googleapis.com/v1alpha/auth_tokens", {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey() },
    body: JSON.stringify({ uses: 1, expireTime: new Date(now + 30 * 60e3).toISOString(), newSessionExpireTime: new Date(now + 2 * 60e3).toISOString() }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new AppError("CONFLICT", `Live voice is unavailable right now (${r.status})`);
  const d = (await r.json()) as { name?: string };
  if (!d.name) throw new AppError("CONFLICT", "Live voice is unavailable right now");
  return d.name;
}

function prompt(o: { lang: Lang; name: string; org: string; opening: string; report: string; facts: unknown; tz: string; nowText: string; sections: string[] }) {
  const ML = o.lang === "ml";
  return [
    `You are Elister, the personal AI assistant of ${o.name || "the owner"}, who owns ${o.org}, a medical clinic in Dubai. This is a live PHONE CALL: you called them to give their daily business update.`,
    ML
      ? `LANGUAGE: Speak natural, warm, everyday Kerala Malayalam, like a trusted assistant on the phone, not formal written style. Say large amounts in lakh and crore with "ദിർഹം". Common English business words (revenue, booking, insurance, doctor) can stay in English as Malayalis say them. If ${o.name || "they"} speaks whole sentences in English, switch to English.`
      : `LANGUAGE: Speak warm, confident, natural English, like a trusted chief of staff on the phone. If ${o.name || "they"} speaks whole sentences in Malayalam, switch to natural Kerala Malayalam.`,
    `CALL FLOW:`,
    `1. When you receive "CALL_CONNECTED", say this opening (you may say it naturally, keep its meaning): "${o.opening}" Then stop and wait for the answer.`,
    `2. If they want to continue (yes, go ahead, sure, I'm good…), give the report below like a real person talking: short spoken sentences, a natural flow between parts ("On the money side…", "Looking at tomorrow…"), about two minutes in total. Cover the parts in this order: ${o.sections.join(", ")}. Round numbers sensibly when speaking. They can interrupt at any time: answer, then carry on from where you were or move on if they prefer.`,
    `3. When the report is done, ask: "Is there anything you'd like to ask me?" and wait.`,
    `4. Answer questions in one to three short spoken sentences, ONLY from the REPORT and FACTS below, or from the ask_books tool for spending, expenses, suppliers, bills, invoices and other bookkeeping questions. Never invent numbers. If the figures don't answer it, say so plainly and say what you can tell them. After answering, briefly check if there is anything else.`,
    `5. If they ask you to call back (later, in N minutes, at a time), call schedule_callback FIRST, then confirm the time in one short sentence, say a short friendly goodbye, and call end_call.`,
    `6. When they are done (no, that's all, thanks, bye), say a warm one-line goodbye using their name and call end_call.`,
    `RULES: Amounts are in UAE dirhams. Never give medical advice. Never mention patients by name. Never read out JSON, field names or lists of numbers. Speak once per turn and never repeat the same sentence. Their local time is ${o.nowText} (${o.tz}).`,
    `REPORT (what to tell them):\n${o.report}`,
    `FACTS (for follow-up questions; amounts in AED):\n${JSON.stringify(o.facts)}`,
  ].join("\n\n");
}

const tools = [{ functionDeclarations: [
  { name: "schedule_callback", description: "Book a call back to the owner. Use minutes_from_now for relative requests (later = 30, half an hour = 30, in an hour = 60) or clock_time for a time of day.",
    parameters: { type: "OBJECT", properties: {
      minutes_from_now: { type: "NUMBER", description: "Minutes from now, e.g. 10, 30, 60" },
      clock_time: { type: "STRING", description: "Time of day in the owner's local time, 24-hour HH:MM, e.g. \"17:30\"" },
    } } },
  { name: "ask_books", description: "Look up the clinic's accounts: spending, expenses by category, suppliers, bills, invoices, cash, profit for a period. Returns a short answer.",
    parameters: { type: "OBJECT", properties: { question: { type: "STRING", description: "The question in plain English" } }, required: ["question"] } },
  { name: "end_call", description: "End the phone call after saying goodbye.", parameters: { type: "OBJECT", properties: {} } },
] }];

export async function liveSession(ctx: Ctx & { name?: string }, langIn?: Lang) {
  assertBrief(ctx);
  if (!liveEnabled()) throw new AppError("CONFLICT", "Live voice is not set up (GEMINI_API_KEY)");
  const [{ facts }, prefs] = await Promise.all([getFacts(ctx), getPrefs(ctx.orgId, ctx.userId)]);
  const lang: Lang = langIn ?? prefs.lang;
  const brief = composeBrief(facts, lang, { sections: prefs.sections });
  const parts = brief.sections.filter((s) => s.key !== "intro" && s.key !== "close");
  const tz = prefs.tz ?? DEFAULT_TZ;
  const nowText = new Date().toLocaleString("en-GB", { timeZone: tz, weekday: "long", hour: "numeric", minute: "2-digit", hour12: true });
  const figures = { ...facts, recipient: undefined }; // the name is given separately
  return {
    token: await liveToken(),
    url: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
    setup: {
      model: `models/${liveModel()}`,
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceFor(lang) } } } },
      systemInstruction: { parts: [{ text: prompt({ lang, name: firstName(facts.recipient), org: facts.org, opening: callOpening(facts, lang), report: parts.map((s) => `${s.title}: ${s.text}`).join("\n"), facts: figures, tz, nowText, sections: parts.map((s) => s.title) }) }] },
      tools,
      inputAudioTranscription: {}, outputAudioTranscription: {},
      realtimeInputConfig: { automaticActivityDetection: { disabled: false, startOfSpeechSensitivity: "START_SENSITIVITY_LOW", endOfSpeechSensitivity: "END_SENSITIVITY_HIGH", prefixPaddingMs: 300, silenceDurationMs: Number(process.env.GEMINI_VAD_SILENCE_MS) || 600 } },
      contextWindowCompression: { slidingWindow: {} },
    },
    lang, tz,
  };
}
