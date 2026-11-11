"use client";
import { useEffect, useRef } from "react";

/**
 * Ambient 3D background: a field of points on a slowly rolling sine surface, projected with perspective and tinted in the
 * brand azure/teal, over two drifting light orbs (CSS). Canvas 2D only, capped at ~30 fps, paused when the tab is hidden and
 * drawn as a single still frame for people who prefer reduced motion.
 */
export function Backdrop() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0, h = 0, raf = 0, last = 0, t = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const resize = () => { w = c.clientWidth; h = c.clientHeight; c.width = w * dpr; c.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    const COLS = 46, ROWS = 26;
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const dark = document.documentElement.classList.contains("dark");
      const fov = 420, cx = w * 0.55, cy = h * 0.62;
      for (let r = 0; r < ROWS; r++) {
        for (let q = 0; q < COLS; q++) {
          const x = (q - COLS / 2) * 34;
          const z = r * 30 + 60;
          const y = Math.sin(q * 0.32 + t) * 22 + Math.cos(r * 0.42 + t * 0.8) * 22 + 110;
          const s = fov / (fov + z);
          const px = cx + x * s, py = cy + (y - 120) * s - r * 9 * s;
          if (px < -10 || px > w + 10 || py < -10 || py > h + 10) continue;
          const depth = 1 - r / ROWS;
          const mix = q / COLS;
          const rC = Math.round(10 + (0 - 10) * mix), gC = Math.round(123 + (160 - 123) * mix), bC = Math.round(165 + (160 - 165) * mix);
          ctx.fillStyle = `rgba(${rC},${gC},${bC},${(dark ? 0.55 : 0.42) * depth * depth + 0.04})`;
          ctx.beginPath(); ctx.arc(px, py, Math.max(0.6, 2.1 * s), 0, Math.PI * 2); ctx.fill();
        }
      }
    };
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 33) return;
      last = now; t += 0.018; draw();
    };
    resize(); draw();
    window.addEventListener("resize", resize);
    const vis = () => { cancelAnimationFrame(raf); if (!document.hidden && !still) raf = requestAnimationFrame(loop); };
    document.addEventListener("visibilitychange", vis);
    vis();
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); document.removeEventListener("visibilitychange", vis); };
  }, []);
  return (
    <div aria-hidden className="backdrop no-print">
      <span className="orb orb-a" /><span className="orb orb-b" /><span className="orb orb-c" />
      <canvas ref={ref} className="absolute inset-0 size-full" />
    </div>
  );
}
