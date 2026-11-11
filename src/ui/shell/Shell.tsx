"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bell, ChevronDown, ChevronRight, Command, Languages, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Search, Settings, Sun, X } from "lucide-react";
import { cn } from "@/ui/kit";
import { ICONS, type IconKey } from "@/ui/shell/icons";
import { ChatDock } from "@/ui/shell/ChatDock";
import { Backdrop } from "@/ui/shell/Backdrop";
import { Spotlight } from "@/ui/shell/Spotlight";

type Item = { href: string; label: string; icon: IconKey };

const GROUP_OF: Record<string, string> = {
  "/dashboard": "Overview", "/chat": "Overview", "/portal": "Overview",
  "/patients": "Clinical", "/appointments": "Clinical", "/queue": "Clinical", "/laboratory": "Clinical", "/radiology": "Clinical", "/pharmacy": "Clinical", "/hospital": "Clinical",
  "/billing": "Revenue", "/insurance": "Revenue", "/accounts": "Finance", "/accounting": "Finance", "/finance": "Finance", "/tax": "Finance", "/books": "Finance", "/procurement": "Operations", "/inventory": "Operations",
  "/hr": "People", "/crm": "People", "/communications": "People",
  "/compliance": "Platform", "/ai": "Platform", "/settings/security": "Platform",
};
const ORDER = ["Overview", "Clinical", "Revenue", "Finance", "Operations", "People", "Platform"];

const initials = (n: string) => n.replace(/\(.*?\)/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "U";
const isActive = (path: string, href: string) => path === href || path.startsWith(href + "/");
const iconBtn = "relative grid size-10 place-items-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-fg";

export function Shell({
  items, quick, orgName, branch, userName, roles, locale, dir, labels, setLocale, signOut, unread, showChat, children,
}: {
  items: Item[]; quick: { href: string; label: string }[]; orgName: string; branch: string; userName: string; roles: string;
  locale: string; dir: "ltr" | "rtl"; labels: { language: string; signOut: string; search: string };
  setLocale: () => Promise<void>; signOut: () => Promise<void>; unread: number; showChat?: boolean; children: ReactNode;
}) {
  const path = usePathname();
  const [dark, setDark] = useState(false);
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  /* Browser-only state (theme, sidebar preference) can only be read after mount. */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    document.documentElement.dir = dir;
    document.documentElement.lang = locale;
    setDark(document.documentElement.classList.contains("dark"));
    try { setCollapsed(localStorage.getItem("sidebar") === "collapsed"); } catch { /* ignore */ }
  }, [dir, locale]);
  useEffect(() => { setDrawer(false); setMenu(false); }, [path]);
  /* eslint-enable react-hooks/set-state-in-effect */
  /* Instant feedback: any in-app link press starts the progress bar and dims the page until the address actually changes. */
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const click = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (a.target && a.target !== "_self") || a.origin !== location.origin) return;
      const from = location.pathname + location.search;
      if (a.pathname + a.search === from) return;
      setBusy(true);
      clearInterval(timer);
      const t0 = Date.now();
      timer = setInterval(() => { if (location.pathname + location.search !== from || Date.now() - t0 > 20000) { clearInterval(timer); setBusy(false); } }, 80);
    };
    document.addEventListener("click", click, true);
    return () => { document.removeEventListener("click", click, true); clearInterval(timer); };
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === "Escape") { setMenu(false); setDrawer(false); }
    };
    const outside = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false); };
    window.addEventListener("keydown", k);
    document.addEventListener("mousedown", outside);
    return () => { window.removeEventListener("keydown", k); document.removeEventListener("mousedown", outside); };
  }, []);

  const toggleTheme = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("theme", next ? "dark" : "light"); } catch { /* ignore */ }
    setDark(next);
  };
  const toggleSidebar = () => { const c = !collapsed; setCollapsed(c); try { localStorage.setItem("sidebar", c ? "collapsed" : "open"); } catch { /* ignore */ } };

  const grouped = useMemo(() => ORDER.map((g) => ({ g, rows: items.filter((i) => (GROUP_OF[i.href] ?? "Platform") === g) })).filter((x) => x.rows.length), [items]);
  const current = useMemo(() => [...items].sort((a, b) => b.href.length - a.href.length).find((i) => isActive(path, i.href)), [items, path]);
  const group = current ? GROUP_OF[current.href] ?? "Platform" : undefined;

  const nav = (isCollapsed: boolean) => (
    <>
      <div className={cn("flex h-16 shrink-0 items-center gap-3 border-b border-border", isCollapsed ? "justify-center px-2" : "px-5")}>
        <Link href="/dashboard" aria-label="Elister Med home" className="flex min-w-0 items-center gap-3">
          <span className="logo-capsule grid size-9 shrink-0 place-items-center rounded-xl"><Image src="/brand/mark.png" alt="" width={20} height={20} priority /></span>
          {!isCollapsed && <span className="min-w-0"><span className="block truncate text-[15px] font-semibold leading-tight text-fg">{orgName}</span><span className="block truncate text-[11px] text-muted">{branch}</span></span>}
        </Link>
      </div>
      <nav aria-label="Primary" className="sb-nav flex-1 overflow-y-auto px-3 pb-3">
        {grouped.map(({ g, rows }) => (
          <Fragment key={g}>
            <div className="sb-group">{g}</div>
            {isCollapsed && <div aria-hidden className="mx-3 my-2 h-px bg-border first:hidden" />}
            {rows.map((i) => {
              const Icon = ICONS[i.icon];
              return (
                <Link key={i.href} href={i.href} title={isCollapsed ? i.label : undefined} aria-current={isActive(path, i.href) ? "page" : undefined} className="sb-item my-0.5">
                  <Icon size={18} strokeWidth={1.8} className="shrink-0" /><span className="sb-label truncate">{i.label}</span>
                </Link>
              );
            })}
          </Fragment>
        ))}
      </nav>
      <div className="shrink-0 space-y-0.5 border-t border-border p-3">
        <Link href="/settings/security" className="sb-item" title={isCollapsed ? "Settings" : undefined}><Settings size={18} strokeWidth={1.8} /><span className="sb-label">Settings</span></Link>
        <form action={signOut}><button className="sb-item w-full hover:!text-danger" title={isCollapsed ? labels.signOut : undefined}><LogOut size={18} strokeWidth={1.8} /><span className="sb-label">{labels.signOut}</span></button></form>
      </div>
    </>
  );

  return (
    <div dir={dir} lang={locale} className="flex min-h-screen">
      <Backdrop /><Spotlight />
      <div aria-hidden className={cn("no-print pointer-events-none fixed inset-x-0 top-0 z-[60] h-[3px] origin-left brand-grad transition-opacity duration-300", busy ? "nav-bar opacity-100" : "opacity-0")} />

      <aside data-collapsed={collapsed} className="sidebar no-print sticky top-0 hidden h-screen shrink-0 flex-col md:flex">{nav(collapsed)}</aside>

      {drawer && (
        <div className="no-print fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-[#0b3558]/35" onClick={() => setDrawer(false)} />
          <aside data-collapsed="false" className="sidebar dock-in absolute inset-y-0 start-0 flex flex-col shadow-[var(--shadow-pop)]">
            <button onClick={() => setDrawer(false)} aria-label="Close menu" className={cn(iconBtn, "absolute end-2 top-3")}><X size={18} /></button>
            {nav(false)}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="topbar no-print sticky top-0 z-20 flex h-16 items-center gap-2 px-4 md:px-6">
          <button onClick={() => setDrawer(true)} aria-label="Open menu" className={cn(iconBtn, "md:hidden")}><Menu size={19} /></button>
          <button onClick={toggleSidebar} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} className={cn(iconBtn, "hidden md:grid")}>{collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button>
          <button onClick={() => setOpen(true)} aria-label="Search" className="flex h-10 w-full max-w-md items-center gap-2.5 rounded-xl border border-border bg-surface-2 px-3.5 text-sm text-muted transition hover:border-primary/40">
            <Search size={16} /><span className="flex-1 truncate text-start">{labels.search} patients, pages, actions…</span><kbd className="hidden rounded-md border border-border bg-surface px-1.5 py-0.5 text-[10px] sm:inline">Ctrl K</kbd>
          </button>
          <div className="ms-auto flex items-center gap-1">
            <form action={setLocale} className="hidden sm:block"><button className={cn(iconBtn, "w-auto gap-1.5 px-3 text-xs font-medium")} aria-label="Switch language"><Languages size={16} />{labels.language}</button></form>
            <button onClick={toggleTheme} aria-label="Toggle theme" className={iconBtn}>{dark ? <Sun size={18} /> : <Moon size={18} />}</button>
            <Link href="/notifications" aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`} className={iconBtn}><Bell size={18} />{unread > 0 && <span className="absolute end-1.5 top-1.5 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white ring-2 ring-surface">{unread > 9 ? "9+" : unread}</span>}</Link>
            <div ref={menuRef} className="relative ms-1">
              <button onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} className="flex items-center gap-2.5 rounded-xl py-1 pe-2 ps-1 transition hover:bg-surface-2">
                <span aria-hidden className="grid size-9 place-items-center rounded-full brand-grad text-xs font-semibold text-white">{initials(userName)}</span>
                <span className="hidden text-start text-xs leading-tight lg:block"><span className="block max-w-36 truncate font-medium text-fg">{userName}</span><span className="block max-w-36 truncate capitalize text-muted">{roles}</span></span>
                <ChevronDown size={15} className="text-muted" />
              </button>
              {menu && (
                <div role="menu" className="panel dock-in absolute end-0 top-12 z-40 w-60 rounded-2xl p-1.5 shadow-[var(--shadow-pop)]">
                  <div className="border-b border-border px-3 pb-2.5 pt-1.5"><div className="truncate text-sm font-medium">{userName}</div><div className="truncate text-xs capitalize text-muted">{roles}</div></div>
                  <Link role="menuitem" href="/settings/security" className="mt-1 flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm hover:bg-surface-2"><Settings size={16} />Security settings</Link>
                  <Link role="menuitem" href="/notifications" className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm hover:bg-surface-2"><Bell size={16} />Notifications</Link>
                  <form action={setLocale}><button role="menuitem" className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm hover:bg-surface-2 sm:hidden"><Languages size={16} />{labels.language}</button></form>
                  <form action={signOut}><button role="menuitem" className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-danger hover:bg-surface-2"><LogOut size={16} />{labels.signOut}</button></form>
                </div>
              )}
            </div>
          </div>
        </header>

        <main aria-busy={busy} className={cn("flex-1 px-4 pb-24 pt-5 transition-opacity duration-200 md:px-6", busy && "opacity-60")}>
          <div className="mx-auto max-w-[1480px]">
            {current && current.href !== "/dashboard" && (
              <nav aria-label="Breadcrumb" className="no-print mb-3 flex items-center gap-1.5 text-xs text-muted">
                <Link href="/dashboard" className="hover:text-fg">Home</Link><ChevronRight size={12} />{group && <><span>{group}</span><ChevronRight size={12} /></>}<span className="font-medium text-fg">{current.label}</span>
              </nav>
            )}
            {children}
          </div>
        </main>
        <footer className="no-print px-6 py-4 text-center text-[11px] text-muted">Elister Med · Your Trusted Family Healthcare Partner in Dubai · Demo environment with synthetic data</footer>
      </div>
      {showChat && <ChatDock />}
      {open && <Palette onClose={() => setOpen(false)} entries={[...items.map((i) => ({ href: i.href, label: i.label })), ...quick]} />}
    </div>
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
    <div role="dialog" aria-modal="true" aria-label="Command palette" className="fixed inset-0 z-50 grid place-items-start justify-center bg-[#0b3558]/30 p-4 pt-24 backdrop-blur-sm" onClick={onClose}>
      <div className="panel w-full max-w-xl overflow-hidden rounded-2xl !bg-surface shadow-[var(--shadow-pop)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-border px-5"><Command size={16} className="text-muted" />
          <input ref={ref} value={q} onChange={(e) => { setQ(e.target.value); setIdx(0); }} placeholder="Type a command or page…" className="w-full bg-transparent py-4 text-sm outline-none"
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, list.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
              if (e.key === "Enter" && list[idx]) go(list[idx].href);
            }} /></div>
        <ul className="max-h-80 overflow-auto p-2">
          {list.map((e, i) => (
            <li key={e.href + e.label}>
              <button onClick={() => go(e.href)} onMouseEnter={() => setIdx(i)} className={cn("w-full rounded-2xl px-4 py-2.5 text-start text-sm transition-colors", i === idx && "bg-surface-2 font-medium")}>{e.label}</button>
            </li>
          ))}
          {list.length === 0 && <li className="px-3 py-8 text-center text-sm text-muted">No results</li>}
        </ul>
      </div>
    </div>
  );
}
