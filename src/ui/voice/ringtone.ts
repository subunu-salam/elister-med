"use client";
/**
 * Elister's caller tune, synthesised with Web Audio (no audio file to load or license): a soft four-note marimba phrase that repeats
 * like a phone ringing. Browsers only allow sound after the person has interacted with the page; if that has not happened yet, start()
 * resolves false and the visual ringing still shows.
 */
let ctx: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let master: GainNode | null = null;

const PHRASE: [number, number][] = [ // [frequency Hz, start offset s]
  [659.25, 0], [783.99, 0.18], [987.77, 0.36], [1318.51, 0.54], // E5 G5 B5 E6
  [987.77, 0.9], [1318.51, 1.08],
];

function note(c: AudioContext, out: AudioNode, f: number, t: number) {
  const o = c.createOscillator(), o2 = c.createOscillator(), g = c.createGain();
  o.type = "sine"; o.frequency.value = f;
  o2.type = "triangle"; o2.frequency.value = f * 4; // marimba-like overtone
  const g2 = c.createGain(); g2.gain.value = 0.08;
  o2.connect(g2).connect(g);
  o.connect(g).connect(out);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.5, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
  o.start(t); o2.start(t); o.stop(t + 0.75); o2.stop(t + 0.75);
}

export async function startRingtone(): Promise<boolean> {
  stopRingtone();
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = ctx ?? new AC();
    if (ctx.state === "suspended") await ctx.resume();
    if (ctx.state !== "running") return false;
    master = ctx.createGain(); master.gain.value = 0.35; master.connect(ctx.destination);
    const play = () => { if (!ctx || !master) return; const t = ctx.currentTime + 0.05; for (const [f, o] of PHRASE) note(ctx, master, f, t + o); };
    play();
    timer = setInterval(play, 2600);
    navigator.vibrate?.([600, 250, 600, 250, 600]);
    return true;
  } catch { return false; }
}

export function stopRingtone() {
  if (timer) clearInterval(timer);
  timer = null;
  if (master) { try { master.gain.setTargetAtTime(0, master.context.currentTime, 0.05); } catch { /* closed */ } master = null; }
  navigator.vibrate?.(0);
}

/** Short two-tone "connected" / "call ended" chimes. */
export async function chime(kind: "connect" | "end") {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = ctx ?? new AC();
    if (ctx.state === "suspended") await ctx.resume();
    const g = ctx.createGain(); g.gain.value = 0.25; g.connect(ctx.destination);
    const t = ctx.currentTime + 0.02;
    const notes = kind === "connect" ? [880, 1318.51] : [880, 587.33];
    notes.forEach((f, i) => note(ctx!, g, f, t + i * 0.14));
  } catch { /* no audio */ }
}
