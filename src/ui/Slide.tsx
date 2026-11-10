"use client";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/ui/kit";

type Box = { x: number; y: number; w: number; h: number };
export type SlideItem = { key: string; label: ReactNode; href: string };

const useIso = typeof window === "undefined" ? useEffect : useLayoutEffect;
const EASE = "cubic-bezier(0.65, 0.05, 0.2, 1)";

/**
 * A row of links with one highlight that slides from the old choice to the new one, like a slider handle.
 * The highlight starts moving the moment a link is pressed (before the page has loaded), and it remembers where it was across
 * page loads so it still glides when the page behind it is replaced. With no active key the highlight fades out.
 */
export function Slide({ items, active, label, track, itemClass, activeClass, thumbClass, storeKey, children }: {
  items: SlideItem[]; active?: string; label: string; track: string; itemClass: string; activeClass: string; thumbClass: string; storeKey: string; children?: ReactNode;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLElement>());
  const [pending, setPending] = useState<string | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [moving, setMoving] = useState(false);
  const shown = pending ?? active;

  /* The page confirmed the new choice, so drop the optimistic one. */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => { setPending(null); }, [active]);

  const measure = useCallback(() => {
    const el = shown ? els.current.get(shown) : undefined;
    if (!el) { setBox(null); return; }
    const b = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
    setBox(b);
    try { sessionStorage.setItem(`slide:${storeKey}`, JSON.stringify(b)); } catch { /* storage unavailable */ }
  }, [shown, storeKey]);

  /* First paint starts where the highlight was on the previous page, then moves to the right place on the next frame. */
  useIso(() => {
    let from: Box | null = null;
    try { from = JSON.parse(sessionStorage.getItem(`slide:${storeKey}`) ?? "null"); } catch { /* ignore */ }
    if (from) setBox(from);
    measure();
    const t = setTimeout(() => setMoving(true), 30); // timers keep running in background tabs, animation frames do not
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useIso(() => { measure(); }, [measure]);
  /* eslint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!wrap.current) return;
    let first = true; // the observer reports once on start; that is not a resize
    const ro = new ResizeObserver(() => { if (first) { first = false; return; } setMoving(false); measure(); setTimeout(() => setMoving(true), 50); });
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [measure]);

  return (
    <div ref={wrap} role="navigation" aria-label={label} className={cn("relative", track)}>
      <span aria-hidden className={cn("pointer-events-none absolute left-0 top-0", thumbClass)}
        style={{ width: box?.w ?? 0, height: box?.h ?? 0, transform: `translate(${box?.x ?? 0}px, ${box?.y ?? 0}px)`, opacity: box ? 1 : 0, transition: moving ? `transform 0.55s ${EASE}, width 0.55s ${EASE}, height 0.55s ${EASE}, opacity 0.2s` : "none" }} />
      {items.map((i) => (
        <Link key={i.key} href={i.href} scroll={false} ref={(n) => { if (n) els.current.set(i.key, n); else els.current.delete(i.key); }}
          aria-current={i.key === shown ? "page" : undefined} onClick={() => setPending(i.key)}
          className={cn("relative z-10 transition-colors duration-300", itemClass, i.key === shown && activeClass)}>{i.label}</Link>
      ))}
      {children}
    </div>
  );
}
