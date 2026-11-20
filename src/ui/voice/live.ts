"use client";
/**
 * Live two-way voice over Gemini Live (same engine and wiring as VoiceBite / Local Link).
 * The microphone streams to Gemini as 16 kHz PCM while the owner talks; Gemini's voice streams back as 24 kHz PCM and plays as it
 * arrives, so it answers about a second after they stop and they can interrupt it at any time. Tool calls are answered by the page.
 */
export type LiveState = "connecting" | "listening" | "speaking" | "idle" | "closed";
export type LiveHandlers = {
  state?: (s: LiveState) => void;
  level?: (v: number) => void;
  heard?: (t: string) => void;   // owner's words, streamed
  said?: (t: string) => void;    // Elister's words, streamed
  turnDone?: () => void;
  tool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  closed?: (reason?: string) => void;
};

const WORKLET = `class P extends AudioWorkletProcessor{constructor(){super();this.b=[];this.r=sampleRate/16000;this.p=0}
process(i){const c=i[0]&&i[0][0];if(!c)return true;for(let k=this.p;k<c.length;k+=this.r){this.b.push(Math.max(-1,Math.min(1,c[Math.floor(k)])))}this.p=(this.p+Math.ceil((c.length-this.p)/this.r)*this.r)-c.length;
if(this.b.length>=1600){const o=new Int16Array(this.b.length);for(let j=0;j<o.length;j++)o[j]=this.b[j]*32767;this.port.postMessage(o.buffer,[o.buffer]);this.b=[]}return true}}registerProcessor('el-pcm',P)`;

type Msg = {
  setupComplete?: unknown;
  toolCall?: { functionCalls?: { id: string; name: string; args?: Record<string, unknown> }[] };
  serverContent?: { interrupted?: boolean; turnComplete?: boolean; inputTranscription?: { text?: string }; outputTranscription?: { text?: string }; modelTurn?: { parts?: { inlineData?: { data?: string } }[] } };
};

/** Only one live call may exist: a second one (double tap, second tab of the same page) would be a second voice talking over the first. */
let current: LiveCall | null = null;
/** Phones play the call through the loudspeaker next to the mic; even with echo cancellation the model hears itself and "answers"
 * its own voice. On touch devices the mic sends silence while Elister is speaking (plus a short tail). Desktop keeps full barge-in. */
const halfDuplex = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

export class LiveCall {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private node: AudioNode | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private playAt = 0;
  private playing: AudioBufferSourceNode[] = [];
  private muted = false;
  private quietUntil = 0;
  open = false;
  constructor(private h: LiveHandlers) {}

  private audio(): AudioContext {
    if (!this.ctx) this.ctx = new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }
  private send(o: unknown) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(o)); }
  /** Stops whatever Elister is saying (when the owner talks over it). */
  flush() { for (const s of this.playing) { try { s.stop(); } catch { /* ended */ } } this.playing = []; this.playAt = 0; }
  /** Seconds of Elister's speech still queued. */
  get speakingFor() { return this.ctx ? Math.max(0, this.playAt - this.ctx.currentTime) : 0; }

  private play(b64: string) {
    const c = this.audio(), bin = atob(b64), n = bin.length >> 1;
    const buf = c.createBuffer(1, n, 24000), ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v > 32767) v -= 65536; ch[i] = v / 32768; }
    const s = c.createBufferSource(); s.buffer = buf; s.connect(c.destination);
    this.playAt = Math.max(this.playAt, c.currentTime + 0.05); s.start(this.playAt); this.playAt += buf.duration;
    this.playing.push(s);
    s.onended = () => { this.playing = this.playing.filter((x) => x !== s); this.quietUntil = c.currentTime + 0.6; if (!this.playing.length) this.h.state?.(this.mic && !this.muted ? "listening" : "idle"); };
    this.h.state?.("speaking");
  }

  private async onMsg(m: Msg) {
    if (m.toolCall) for (const fc of m.toolCall.functionCalls ?? []) {
      let result: unknown;
      try { result = (await this.h.tool?.(fc.name, fc.args ?? {})) ?? { ok: true }; } catch (e) { result = { error: (e as Error).message || "failed" }; }
      this.send({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { result } }] } });
    }
    const sc = m.serverContent; if (!sc) return;
    if (sc.interrupted) { this.flush(); this.h.state?.("listening"); }
    if (sc.inputTranscription?.text) this.h.heard?.(sc.inputTranscription.text);
    if (sc.outputTranscription?.text) this.h.said?.(sc.outputTranscription.text);
    for (const p of sc.modelTurn?.parts ?? []) if (p.inlineData?.data) this.play(p.inlineData.data);
    if (sc.turnComplete) this.h.turnDone?.();
  }

  /** Opens the session (server gives a one-use token and the setup). Resolves false if it could not connect. */
  async connect(lang?: string): Promise<boolean> {
    if (current && current !== this) current.close();
    current = this;
    this.audio(); this.h.state?.("connecting");
    const r = await fetch("/api/ai/live", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lang }) });
    if (!r.ok) return false;
    const s = (await r.json()) as { token: string; url: string; setup: unknown };
    const ok = await new Promise<boolean>((res) => {
      let done = false; const fin = (v: boolean) => { if (!done) { done = true; res(v); } };
      setTimeout(() => fin(false), 8000);
      const ws = new WebSocket(`${s.url}?access_token=${encodeURIComponent(s.token)}`); this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ setup: s.setup }));
      ws.onmessage = async (e) => {
        try { const t = typeof e.data === "string" ? e.data : await (e.data as Blob).text(); const m = JSON.parse(t) as Msg; if (m.setupComplete) fin(true); else void this.onMsg(m); } catch { /* ignore */ }
      };
      ws.onclose = (e) => { const was = this.open; this.open = false; fin(false); this.stopMic(); if (was) this.h.closed?.(e.reason); };
      ws.onerror = () => fin(false);
    });
    this.open = ok;
    if (!ok) { try { this.ws?.close(); } catch { /* closed */ } }
    return ok;
  }

  async startMic() {
    const c = this.audio(); if (this.mic) { this.muted = false; return; }
    try { this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) { if (/Overconstrained|NotReadable|Abort/i.test((e as Error).name)) this.mic = await navigator.mediaDevices.getUserMedia({ audio: true }); else throw e; }
    this.src = c.createMediaStreamSource(this.mic);
    const an = c.createAnalyser(); an.fftSize = 256; this.src.connect(an); const d = new Uint8Array(an.fftSize);
    const out = (buf: ArrayBuffer) => {
      if (this.muted) return;
      if (halfDuplex() && (this.playing.length > 0 || c.currentTime < this.quietUntil)) buf = new ArrayBuffer(buf.byteLength); // silence while Elister talks
      const u = new Uint8Array(buf); let bin = ""; for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
      this.send({ realtimeInput: { audio: { data: btoa(bin), mimeType: "audio/pcm;rate=16000" } } });
      an.getByteTimeDomainData(d); let sum = 0; for (const v of d) { const x = v - 128; sum += x * x; } this.h.level?.(Math.min(1, Math.sqrt(sum / d.length) / 20));
    };
    try {
      await c.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" })));
      const n = new AudioWorkletNode(c, "el-pcm"); n.port.onmessage = (e) => out(e.data as ArrayBuffer); this.src.connect(n); this.node = n;
    } catch {
      const sp = c.createScriptProcessor(4096, 1, 1), r = c.sampleRate / 16000;
      sp.onaudioprocess = (ev) => { const ch = ev.inputBuffer.getChannelData(0); const n = Math.floor(ch.length / r); const o = new Int16Array(n); for (let i = 0; i < n; i++) o[i] = Math.max(-1, Math.min(1, ch[Math.floor(i * r)])) * 32767; out(o.buffer); };
      const mute = c.createGain(); mute.gain.value = 0; this.src.connect(sp); sp.connect(mute); mute.connect(c.destination); this.node = sp;
    }
    this.h.state?.("listening");
  }
  setMuted(m: boolean) { this.muted = m; this.h.state?.(m ? "idle" : "listening"); }
  get isMuted() { return this.muted; }
  stopMic() { try { this.node?.disconnect(); this.src?.disconnect(); this.mic?.getTracks().forEach((t) => t.stop()); } catch { /* gone */ } this.mic = null; this.node = null; this.src = null; }
  /** Sends a text turn (used for "CALL_CONNECTED" and typed questions). */
  text(t: string) { this.flush(); this.send({ clientContent: { turns: [{ role: "user", parts: [{ text: t }] }], turnComplete: true } }); }
  close() { if (current === this) current = null; this.stopMic(); this.flush(); this.open = false; try { this.ws?.close(); } catch { /* closed */ } this.ws = null; }
}
