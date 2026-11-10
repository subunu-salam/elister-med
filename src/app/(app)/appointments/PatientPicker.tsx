"use client";
import { useEffect, useState } from "react";
import { Input } from "@/ui/kit";

type Hit = { _id: string; mrn: string; fullName: string; fullNameAr?: string; phone: string };

/** Debounced smart search. Posts the chosen patient id in a hidden input. */
export function PatientPicker({ initial }: { initial?: { id: string; label: string } }) {
  const [q, setQ] = useState(initial?.label ?? "");
  const [hits, setHits] = useState<Hit[]>([]);
  const [picked, setPicked] = useState<string>(initial?.id ?? "");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (picked || q.trim().length < 2) return;
    const h = setTimeout(async () => {
      const r = await fetch(`/api/patients/search?q=${encodeURIComponent(q)}`);
      if (r.ok) { setHits(await r.json()); setOpen(true); }
    }, 250);
    return () => clearTimeout(h);
  }, [q, picked]);

  return (
    <div className="relative">
      <input type="hidden" name="patientId" value={picked} />
      <Input value={q} onChange={(e) => { setQ(e.target.value); setPicked(""); if (e.target.value.trim().length < 2) setHits([]); }} placeholder="Search patient by name, MRN or phone" aria-label="Patient" autoComplete="off" role="combobox" aria-expanded={open} />
      {open && hits.length > 0 && (
        <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-ui border border-border bg-surface shadow-lg" role="listbox">
          {hits.map((h) => (
            <li key={h._id}>
              <button type="button" role="option" aria-selected={false} className="w-full px-3 py-2 text-start text-sm hover:bg-surface-2"
                onClick={() => { setPicked(h._id); setQ(`${h.fullName} (${h.mrn})`); setOpen(false); }}>
                {h.fullName} {h.fullNameAr && <span dir="rtl" className="text-muted">{h.fullNameAr}</span>} <span className="text-xs text-muted">· {h.mrn} · {h.phone}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!picked && q.trim().length >= 2 && !open && hits.length === 0 && <p className="mt-1 text-xs text-muted">No match yet — keep typing, or select a result.</p>}
    </div>
  );
}
