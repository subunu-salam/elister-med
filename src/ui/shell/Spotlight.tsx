"use client";
import { useEffect } from "react";

/** Feeds the pointer position to `.panel` tiles as CSS variables so their border glow follows the cursor. One listener for the page. */
export function Spotlight() {
  useEffect(() => {
    if (window.matchMedia("(pointer: coarse)").matches) return;
    let raf = 0, ev: PointerEvent | null = null;
    const move = (e: PointerEvent) => {
      ev = e;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const el = (ev?.target as HTMLElement | null)?.closest?.(".panel") as HTMLElement | null;
        if (!el || !ev) return;
        const r = el.getBoundingClientRect();
        el.style.setProperty("--mx", `${ev.clientX - r.left}px`);
        el.style.setProperty("--my", `${ev.clientY - r.top}px`);
      });
    };
    document.addEventListener("pointermove", move, { passive: true });
    return () => document.removeEventListener("pointermove", move);
  }, []);
  return null;
}
