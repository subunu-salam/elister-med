"use client";
import { useEffect, useRef, useState } from "react";

/** Animates the first number inside a formatted string ("AED 12,480.00", "1,105", "4.2%") from zero, keeping the format. */
export function CountUp({ text, ms = 1100 }: { text: string; ms?: number }) {
  const [shown, setShown] = useState(text);
  const done = useRef(false);
  useEffect(() => {
    const m = text.match(/-?[\d,]*\.?\d+/);
    if (!m || done.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    done.current = true;
    const raw = m[0], target = Number(raw.replace(/,/g, ""));
    const dec = raw.includes(".") ? raw.split(".")[1].length : 0, commas = raw.includes(",");
    const fmt = (v: number) => { const s = v.toFixed(dec); return commas ? Number(s).toLocaleString("en-AE", { minimumFractionDigits: dec, maximumFractionDigits: dec }) : s; };
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - p, 3);
      setShown(text.replace(raw, fmt(target * e)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, ms]);
  return <span className="tabular-nums">{shown}</span>;
}
