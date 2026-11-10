"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Trash2 } from "lucide-react";
import { cn } from "@/ui/kit";

const SIDE = 320;

/** Square-crops and shrinks the chosen picture in the browser before upload, so phone photos stay well under the size limit. */
async function shrink(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIDE;
  canvas.getContext("2d")!.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, SIDE, SIDE);
  return await new Promise<Blob>((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error("encode"))), "image/jpeg", 0.86));
}

export function PhotoUpload({ userId, label = "Change photo", compact, hasPhoto, className }: { userId: string; label?: string; compact?: boolean; hasPhoto?: boolean; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function pick(file?: File) {
    if (!file) return;
    setBusy(true); setErr("");
    try {
      const fd = new FormData();
      fd.set("file", await shrink(file), "photo.jpg");
      const r = await fetch(`/api/photo/${encodeURIComponent(userId)}`, { method: "POST", body: fd });
      if (!r.ok) setErr(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? "Upload failed");
      else router.refresh();
    } catch { setErr("That file could not be read as a picture"); }
    setBusy(false);
    if (input.current) input.current.value = "";
  }
  async function remove() {
    setBusy(true); setErr("");
    const r = await fetch(`/api/photo/${encodeURIComponent(userId)}`, { method: "DELETE" });
    if (!r.ok) setErr("Could not remove the photo"); else router.refresh();
    setBusy(false);
  }

  return (
    <span className={cn("inline-flex flex-col items-start gap-1", className)}>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} aria-label={label} />
      <span className="flex items-center gap-2">
        <button type="button" disabled={busy} onClick={() => input.current?.click()} title={label} aria-label={label}
          className={cn("inline-flex items-center justify-center gap-1.5 rounded-full bg-surface text-fg shadow-card transition hover:bg-surface-2 disabled:opacity-50", compact ? "size-8" : "px-4 py-2 text-sm font-medium")}>
          <Camera size={compact ? 15 : 16} />{!compact && (busy ? "Uploading…" : label)}
        </button>
        {!compact && hasPhoto && <button type="button" disabled={busy} onClick={remove} className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-sm text-muted hover:text-danger"><Trash2 size={15} />Remove</button>}
      </span>
      {err && <span role="alert" className="text-xs text-danger">{err}</span>}
    </span>
  );
}
