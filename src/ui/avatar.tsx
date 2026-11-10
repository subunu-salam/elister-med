import { cn } from "@/ui/kit";

const SKIN = ["#f2cfae", "#e3b08a", "#c98d5f", "#9a6240", "#f6dcc6"];
const HAIR = ["#1d1b1f", "#3a281d", "#6a4526", "#8b9099", "#101012"];
const COLLAR = ["#0b3558", "#0a7ba5", "#00a0a0"];

const hash = (s: string) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

/**
 * A person's picture: their uploaded photo when there is one, otherwise a drawn portrait in the Elister colours that is the same
 * every time for the same name (hair, skin tone and collar are picked from the name), so lists never show empty circles.
 */
export function Avatar({ name, userId, photo, size = 48, className }: { name: string; userId?: string; photo?: number | null; size?: number; className?: string }) {
  const base = cn("shrink-0 rounded-full object-cover", className);
  if (userId && photo) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={`/api/photo/${encodeURIComponent(userId)}?v=${photo}`} alt="" width={size} height={size} loading="lazy" className={base} style={{ width: size, height: size }} />;
  }
  const clean = name.replace(/\s*\(.*?\)\s*/g, "").trim();
  const h = hash(clean || "staff");
  const skin = SKIN[h % SKIN.length], hair = HAIR[(h >> 3) % HAIR.length], collar = COLLAR[(h >> 5) % COLLAR.length], style = (h >> 7) % 3;
  const doctor = /^dr\.?\s/i.test(clean);
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} role="img" aria-label={clean} className={cn(base, "bg-tint")} style={{ width: size, height: size }}>
      {style === 1 && <path d="M20.5 31C20.5 18 26 12 32 12s11.5 6 11.5 19v17h-23z" fill={hair} />}
      <path d="M7 66c0-14 11-21.5 25-21.5S57 52 57 66z" fill={doctor ? "#ffffff" : collar} />
      {doctor && <path d="M25.5 45L32 57l6.5-12z" fill={collar} />}
      {doctor && <path d="M24 47.5c0 9.5 16 9.5 16 0" fill="none" stroke="#6d7d8e" strokeWidth="1.5" strokeLinecap="round" />}
      <rect x="28" y="38" width="8" height="9" rx="3" fill={skin} />
      <ellipse cx="32" cy="29.5" rx="9.5" ry="11" fill={skin} />
      <path d="M22 28.5c0-9 5-13.5 10-13.5s10 4.5 10 13.5c-3-5.5-6.5-7.5-10-7.5s-7 2-10 7.5z" fill={hair} />
      {style === 2 && <circle cx="32" cy="14" r="4.5" fill={hair} />}
      <circle cx="28.3" cy="30.5" r="1" fill="#2a2a30" /><circle cx="35.7" cy="30.5" r="1" fill="#2a2a30" />
      <path d="M29.5 35.2c1.6 1.3 3.4 1.3 5 0" fill="none" stroke="#7a4a3a" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}
