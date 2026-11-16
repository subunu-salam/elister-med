import "server-only";
import { createHash } from "node:crypto";
import type { BriefFacts, Lang } from "./brief-core";

/**
 * Optional natural voice for the brief, using the same Google Gemini key VoiceBite uses for Arabic and Malayalam.
 *
 * Off by default: the brief then speaks with the browser's own voices and nothing leaves Elister. Turning it on is a deliberate
 * decision by the clinic, and needs BOTH of these environment variables:
 *
 *   GEMINI_API_KEY (or GOOGLE_API_KEY)   key from https://aistudio.google.com/apikey
 *   ELISTER_VOICE_EXTERNAL=1             records that the owner approved sending brief text to Google
 *
 * What is sent: only the brief's aggregate figures and the names of doctors, insurers and corporate clients. No patient names,
 * IDs, diagnoses or any clinical data are ever part of the brief, so none can be sent.
 *
 * Optional: GEMINI_TTS_MODEL (default gemini-2.5-flash-preview-tts), GEMINI_TEXT_MODEL (default gemini-2.5-flash),
 * GEMINI_VOICE (default "Kore"; GEMINI_VOICE_ML picks a different one for Malayalam).
 */
const KEY = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const API = "https://generativelanguage.googleapis.com/v1beta/models";

export function voiceProvider() {
  const on = !!KEY() && process.env.ELISTER_VOICE_EXTERNAL === "1";
  return { natural: on, name: on ? ("gemini" as const) : ("browser" as const) };
}

const cache = new Map<string, Uint8Array>();

/** Text to a WAV file (16-bit mono 24 kHz). Returns null when the natural voice is off or the call fails; the client then uses the browser voice. */
export async function synthesize(text: string, lang: Lang): Promise<Uint8Array | null> {
  if (!voiceProvider().natural) return null;
  const clipped = text.slice(0, 1500);
  const id = createHash("sha256").update(`${lang}:${clipped}`).digest("hex");
  const hit = cache.get(id);
  if (hit) return hit;

  const voice = (lang === "ml" && process.env.GEMINI_VOICE_ML) || process.env.GEMINI_VOICE || "Kore";
  const style = lang === "ml"
    ? "Read this aloud in natural, warm Kerala Malayalam, like a calm business news presenter. Say amounts naturally:"
    : "Read this aloud in a warm, confident, unhurried voice, like a personal chief of staff giving a morning briefing:";
  const res = await fetch(`${API}/${process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts"}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": KEY() },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${style}\n\n${clipped}` }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) { console.error("gemini tts", res.status, (await res.text()).slice(0, 300)); return null; }
  const j = (await res.json()) as { candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[] };
  const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!part?.data) return null;
  const rate = Number(/rate=(\d+)/.exec(part.mimeType ?? "")?.[1] ?? 24000);
  const wav = pcmToWav(Buffer.from(part.data, "base64"), rate);
  if (cache.size > 200) cache.clear();
  cache.set(id, wav);
  return wav;
}

export function pcmToWav(pcm: Uint8Array, rate = 24000, channels = 1): Uint8Array {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return new Uint8Array(Buffer.concat([h, Buffer.from(pcm)]));
}

/** Free-form follow-up answered by the model from the brief's figures only. Null when the external voice is off. */
export async function askExternal(question: string, facts: BriefFacts, lang: Lang): Promise<string | null> {
  if (!voiceProvider().natural) return null;
  const sys = [
    "You are Elister, the personal business assistant of a medical clinic's owner and investors.",
    "Answer ONLY from the JSON figures provided. If the figures do not contain the answer, say so plainly and suggest what you can answer.",
    "Never give medical advice. Never invent numbers. Amounts are in UAE dirhams.",
    lang === "ml" ? "Reply in natural spoken Malayalam (Malayalam script), using lakh/crore for large amounts." : "Reply in plain spoken English.",
    "Keep it to at most three short sentences: it will be read aloud.",
  ].join(" ");
  const res = await fetch(`${API}/${process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash"}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": KEY() },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{ role: "user", parts: [{ text: `Figures:\n${JSON.stringify(facts)}\n\nQuestion: ${question}` }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim() || null;
}
