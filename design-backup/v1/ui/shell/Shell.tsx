"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bell, BedDouble, BookOpen, Bot, CalendarDays, ChevronsLeft, ChevronsRight, ClipboardCheck, Command, FlaskConical, Heart, Landmark, LayoutDashboard, ListOrdered, LogOut, MapPin, MessageSquare, Moon, Package, Pill, Receipt, Search, ShieldCheck, Sun, UserCog, Users } from "lucide-react";
import { cn } from "@/ui/kit";

const ICONS = { dash: LayoutDashboard, users: Users, cal: CalendarDays, queue: ListOrdered, bill: Receipt, book: BookOpen, shield: ShieldCheck, med: Pill, flask: FlaskConical, box: Package, people: UserCog, heart: Heart, chat: MessageSquare, check: ClipboardCheck, bank: Landmark, bed: BedDouble, bot: Bot } as const;
type Item = { href: string; label: string; icon: keyof typeof ICONS };

const GROUP_OF: Record<string, string> = {
  "/dashboard": "Overview", "/portal": "Overview",
  "/patients": "Clinical", "/appointments": "Clinical", "/queue": "Clinical", "/laboratory": "Clinical", "/radiology": "Clinical", "/pharmacy": "Clinical", "/hospital": "Clinical",
  "/billing": "Revenue", "/insurance": "Revenue", "/accounting": "Finance", "/finance": "Finance", "/tax": "Finance", "/books": "Finance", "/procurement": "Operations", "/inventory": "Operations",
  "/hr": "People", "/crm": "People", "/communications": "People",
  "/compliance": "Platform", "/ai": "Platform", "/settings/security": "Platform",
};
const ORDER = ["Overview", "Clinical", "Revenue", "Finance", "Operations", "People", "Platform"];

const initials = (n: string) => n.replace(/\(.*?\)/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "U";

export function Shell({
  items, quick, orgName, branch, userName, roles, locale, dir, labels, setLocale, signOut, unread, children,
}: {
  items: Item[]; quick: { href: string; label: string }[]; orgName: string; branch: string; userName: string; roles: string;
  locale: string; dir: "ltr" | "rtl"; labels: { language: string; signOut: string; search: string };
  setLocale: () => Promise<void>; signOut: () => Promise<void>; unread: number; children: ReactNode;
}) {
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [dark, setDark] = useState(false);
  const [open, setOpen] = useState(false);

  /* Browser-only state (theme class, saved sidebar state) can only be read after mount. */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    document.documentElement.dir = dir;
    document.documentElement.lang = locale;
    setDark(document.documentElement.classList.contains("dark"));
    try { setCollapsed(localStorage.getItem("nav-collapsed") === "1"); } catch { /* storage unavailable */ }
  }, [dir, locale]);
  /* eslint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const toggleTheme = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("theme", next ? "dark" : "light"); } catch { /* ignore */ }
    setDark(next);
  };
  const toggleNav = () => {
    setCollapsed((c) => { try { localStorage.setItem("nav-collapsed", c ? "0" : "1"); } catch { /* ignore */ } return !c; });
  };

  const crumbs = path.split("/").filter(Boolean);
  const grouped = useMemo(() => ORDER.map((g) => ({ g, rows: items.filter((i) => (GROUP_OF[i.href] ?? "Platform") === g) })).filter((x) => x.rows.length), [items]);

  return (
    <div dir={dir} lang={locale} className="flex min-h-screen">
      <aside className={cn("no-print side-grad sticky top-0 hidden h-screen shrink-0 flex-col text-white shadow-[4px_0_30px_-12px_rgba(6,22,31,.5)] transition-[width] duration-300 md:flex", collapsed ? "w-[76px]" : "w-64")}>
        <div className={cn("flex h-16 items-center border-b border-white/10", collapsed ? "justify-center" : "px-5")}>
          {collapsed ? <Image src="/brand/mark.png" alt="Elister Med" width={30} height={30} /> : <Image src="/brand/logo-header.png" alt="Elister Med" width={227} height={109} className="h-9 w-auto" priority />}
        </div>
        {!collapsed && (
          <div className="mx-4 mt-4 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] px-3 py-2 text-xs">
            <MapPin size={14} className="shrink-0 text-cyan-200" /><div className="min-w-0"><div className="truncate font-medium">{orgName}</div><div className="truncate text-white/60">{branch}</div></div>
          </div>
        )}
        <nav aria-label="Primary" className="mt-3 flex-1 space-y-4 overflow-y-auto px-3 pb-3">
          {grouped.map(({ g, rows }) => (
            <div key={g}>
              {!collapsed && <div className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/40">{g}</div>}
              <div className="space-y-0.5">
                {rows.map((i) => {
                  const Icon = ICONS[i.icon];
                  const active = path === i.href || path.startsWith(i.href + "/");
                  return (
                    <Link key={i.href} href={i.href} title={i.label} aria-current={active ? "page" : undefined}
                      className={cn("group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors", collapsed && "justify-center", active ? "bg-white/[0.14] font-medium text-white" : "text-white/70 hover:bg-white/[0.08] hover:text-white")}>
                      {active && <span aria-hidden className="absolute inset-y-2 start-0 w-1 rounded-e-full bg-gradient-to-b from-cyan-200 to-teal-300" />}
                      <Icon size={18} className={cn("shrink-0", active ? "text-cyan-200" : "text-white/60 group-hover:text-cyan-200")} />
                      {!collapsed && <span className="truncate">{i.label}</span>}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
        <div className="border-t border-white/10 p-3">
          <button onClick={toggleNav} aria-label="Toggle sidebar" className={cn("flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs text-white/60 transition-colors hover:bg-white/[0.08] hover:text-white", collapsed && "justify-center")}>
            {collapsed ? <ChevronsRight size={16} /> : <><ChevronsLeft size={16} /> Collapse</>}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print glass sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border/70 px-4 md:px-6">
          <span aria-hidden className="accent-grad absolute inset-x-0 top-0 h-[3px]" />
          <Link href="/dashboard" className="shrink-0 md:hidden" aria-label="Elister Med home"><Image src="/brand/logo-footer.png" alt="Elister Med" width={235} height={117} className="h-9 w-auto dark:hidden" /><Image src="/brand/logo-header.png" alt="Elister Med" width={227} height={109} className="hidden h-9 w-auto dark:block" /></Link>
          <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 text-sm text-muted sm:flex">
            <Link href="/dashboard" className="hover:text-fg">Home</Link>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1.5"><span aria-hidden className="text-border">/</span><span className={cn("truncate capitalize", i === crumbs.length - 1 && "font-medium text-fg")}>{decodeURIComponent(c).slice(0, 24)}</span></span>
            ))}
          </nav>
          <div className="ms-auto flex items-center gap-1.5">
            <button onClick={() => setOpen(true)} className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-xs text-muted transition-colors hover:border-primary/40" aria-label="Open command palette">
              <Search size={14} /> <span className="hidden sm:inline">{labels.search}</span> <kbd className="hidden rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] sm:inline">Ctrl K</kbd>
            </button>
            <Link href="/notifications" aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`} className="relative rounded-xl p-2.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"><Bell size={17} />{unread > 0 && <span className="absolute -end-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white ring-2 ring-surface">{unread > 9 ? "9+" : unread}</span>}</Link>
            <form action={setLocale}><button className="rounded-xl px-3 py-2 text-xs font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-fg" aria-label="Switch language">{labels.language}</button></form>
            <button onClick={toggleTheme} aria-label="Toggle theme" className="rounded-xl p-2.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg">{dark ? <Sun size={17} /> : <Moon size={17} />}</button>
            <div className="mx-1 hidden h-8 w-px bg-border sm:block" />
            <div className="hidden items-center gap-2.5 sm:flex">
              <span aria-hidden className="brand-grad grid size-9 place-items-center rounded-full text-xs font-bold text-white shadow-sm">{initials(userName)}</span>
              <div className="text-start text-xs leading-tight"><div className="max-w-40 truncate font-semibold">{userName}</div><div className="max-w-40 truncate capitalize text-muted">{roles}</div></div>
            </div>
            <form action={signOut}><button className="flex items-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-xs font-semibold transition-colors hover:border-danger/40 hover:text-danger"><LogOut size={14} />{labels.signOut}</button></form>
          </div>
        </header>
        <MobileNav items={items} path={path} />
        <main className="flex-1 p-4 md:p-8"><div className="mx-auto max-w-[1400px]">{children}</div></main>
        <footer className="no-print border-t border-border/70 px-6 py-3 text-center text-[11px] text-muted"><Image src="/brand/mark.png" alt="" aria-hidden width={14} height={14} className="me-1.5 inline-block align-[-2px]" />Elister Med · Your Trusted Family Healthcare Partner in Dubai · Demo environment with synthetic data</footer>
      </div>
      {open && <Palette onClose={() => setOpen(false)} entries={[...items.map((i) => ({ href: i.href, label: i.label })), ...quick]} />}
    </div>
  );
}

function MobileNav({ items, path }: { items: Item[]; path: string }) {
  return (
    <nav aria-label="Mobile" className="no-print flex gap-1.5 overflow-x-auto border-b border-border bg-surface px-3 py-2 md:hidden">
      {items.map((i) => (
        <Link key={i.href} href={i.href} className={cn("shrink-0 rounded-full px-3.5 py-1.5 text-xs font-medium", path.startsWith(i.href) ? "brand-grad text-white" : "bg-surface-2 text-muted")}>{i.label}</Link>
      ))}
    </nav>
  );
}

function Palette({ entries, onClose }: { entries: { href: string; label: string }[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const list = useMemo(() => entries.filter((e) => e.label.toLowerCase().includes(q.toLowerCase())), [entries, q]);
  const go = (href: string) => { onClose(); window.location.assign(href); };
  return (
    <div role="dialog" aria-modal="true" aria-label="Command palette" className="fixed inset-0 z-50 grid place-items-start justify-center bg-[#06161f]/55 p-4 pt-24 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-pop)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-border px-4"><Command size={16} className="text-muted" />
          <input ref={ref} value={q} onChange={(e) => { setQ(e.target.value); setIdx(0); }} placeholder="Type a command or page…" className="w-full bg-transparent py-3.5 text-sm outline-none"
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, list.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
              if (e.key === "Enter" && list[idx]) go(list[idx].href);
            }} /></div>
        <ul className="max-h-80 overflow-auto p-2">
          {list.map((e, i) => (
            <li key={e.href + e.label}>
              <button onClick={() => go(e.href)} onMouseEnter={() => setIdx(i)} className={cn("w-full rounded-xl px-3 py-2.5 text-start text-sm transition-colors", i === idx && "bg-primary/10 text-primary-strong")}>{e.label}</button>
            </li>
          ))}
          {list.length === 0 && <li className="px-3 py-8 text-center text-sm text-muted">No results</li>}
        </ul>
      </div>
    </div>
  );
}
