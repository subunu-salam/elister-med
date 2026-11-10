"use client";
/** Print and CSV export for the report on screen. Reads the first table inside [data-report]. */
export function ReportTools({ name }: { name: string }) {
  const csv = () => {
    const t = document.querySelector("[data-report] table");
    if (!t) return;
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const rows = [...t.querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("th,td")].map((c) => esc((c.textContent ?? "").replace(/AED\s?/g, "").replace(/,(?=\d{3})/g, "").trim())).join(","));
    const url = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${name}.csv`; a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="flex gap-2 print:hidden">
      <button type="button" onClick={csv} className="rounded-full border border-border px-3 py-1.5 text-xs hover:bg-surface-2">Export CSV</button>
      <button type="button" onClick={() => window.print()} className="rounded-full border border-border px-3 py-1.5 text-xs hover:bg-surface-2">Print / PDF</button>
    </div>
  );
}
