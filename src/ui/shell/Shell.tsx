"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bell, Command, LogOut, Moon, Search, Sun } from "lucide-react";
import { cn } from "@/ui/kit";
import { ICONS, type IconKey } from "@/ui/shell/icons";
import { Slide } from "@/ui/Slide";
import { ChatDock } from "@/ui/shell/ChatDock";

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
const iconBtn = "grid size-10 place-items-center rounded-full bg-surface text-fg shadow-card transition hover:bg-surface-2";

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
  const [dot, setDot] = useState<{ y: number; ready: boolean }>({ y: 0, ready: false });
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navRef = useRef<HTMLElement>(null);

  /* Browser-only state (theme class) can only be read after mount. */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    document.documentElement.dir = dir;
    document.documentElement.lang = locale;
    setDark(document.documentElement.classList.contains("dark"));
  }, [dir, locale]);
  /* The rail indicator glides to the active link: measure after layout, again when fonts or the window change. */
  useEffect(() => { setPending(null); }, [path]);
  useEffect(() => {
    const place = () => {
      const a = navRef.current?.querySelector<HTMLElement>("[aria-current='page']");
      if (a) {
        a.scrollIntoView({ block: "nearest" }); // the rail scrolls when the screen is short; keep the chosen item in view
        setDot((d) => (d.ready && d.y === a.offsetTop ? d : { y: a.offsetTop, ready: true }));
      } else setDot((d) => (d.ready ? { ...d, ready: false } : d));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [path, pending]);
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

  const grouped = useMemo(() => ORDER.map((g) => ({ g, rows: items.filter((i) => (GROUP_OF[i.href] ?? "Platform") === g) })).filter((x) => x.rows.length), [items]);
  const pill = quick.slice(0, 3);

  return (
    <div dir={dir} lang={locale} className="flex min-h-screen">
      <div aria-hidden className={cn("no-print pointer-events-none fixed inset-x-0 top-0 z-[60] h-[3px] origin-left brand-grad transition-opacity duration-300", busy ? "nav-bar opacity-100" : "opacity-0")} />
      <aside className="no-print relative hidden w-[92px] shrink-0 md:block">
        <div className="rail side-glass fixed inset-y-3 start-3 z-30 flex flex-col overflow-hidden rounded-[34px] text-white">
          <Link href="/dashboard" aria-label="Elister Med home" className="flex h-[76px] shrink-0 items-center gap-3 ps-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-white/10"><Image src="/brand/mark.png" alt="" width={26} height={26} priority /></span>
            <span className="rail-label min-w-0"><span className="block truncate text-sm font-medium">{orgName}</span><span className="block truncate text-xs text-white/55">{branch}</span></span>
          </Link>
          <nav ref={navRef} aria-label="Primary" className="rail-nav relative flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3">
            <span aria-hidden className={cn("rail-dot pointer-events-none absolute inset-x-3 h-11 rounded-full brand-grad shadow-[0_8px_18px_-8px_rgba(0,160,160,.8)]", dot.ready ? "opacity-100" : "opacity-0")} style={{ top: dot.y }} />
            {grouped.map(({ g, rows }, gi) => (
              <Fragment key={g}>
                {gi > 0 && <div aria-hidden className="mx-3 my-2 h-px bg-white/10" />}
                {rows.map((i) => {
                  const Icon = ICONS[i.icon];
                  const active = pending ? pending === i.href : isActive(path, i.href);
                  return (
                    <Link key={i.href} href={i.href} title={i.label} aria-current={active ? "page" : undefined} onClick={() => setPending(i.href)}
                      className={cn("group relative z-10 flex h-11 items-center gap-3 rounded-full text-sm transition-colors", active ? "text-white" : "text-white/65 hover:text-white", active && !dot.ready && "brand-grad")}>
                      <span className={cn("grid size-11 shrink-0 place-items-center rounded-full transition-colors", !active && "group-hover:bg-white/10")}><Icon size={19} strokeWidth={1.75} /></span>
                      <span className={cn("rail-label truncate pe-4", active && "font-medium")}>{i.label}</span>
                    </Link>
                  );
                })}
              </Fragment>
            ))}
          </nav>
          <div className="flex shrink-0 flex-col items-start gap-1 border-t border-white/10 px-3 py-3">
            <button onClick={toggleTheme} aria-label="Toggle theme" className="group flex h-11 w-full items-center gap-3 rounded-full text-sm text-white/65 hover:text-white">
              <span className="grid size-11 shrink-0 place-items-center rounded-full group-hover:bg-white/10">{dark ? <Sun size={19} strokeWidth={1.75} /> : <Moon size={19} strokeWidth={1.75} />}</span>
              <span className="rail-label">{dark ? "Light mode" : "Dark mode"}</span>
            </button>
            <form action={signOut} className="w-full">
              <button aria-label={labels.signOut} className="group flex h-11 w-full items-center gap-3 rounded-full text-sm text-white/65 hover:text-white">
                <span className="grid size-11 shrink-0 place-items-center rounded-full group-hover:bg-white/10"><LogOut size={19} strokeWidth={1.75} /></span>
                <span className="rail-label">{labels.signOut}</span>
              </button>
            </form>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col md:pe-3">
        <header className="no-print sticky top-0 z-20 flex items-center gap-3 bg-bg px-4 py-3 md:px-6 md:ps-3">
          <Link href="/dashboard" className="grid size-10 shrink-0 place-items-center rounded-full bg-rail md:hidden" aria-label="Elister Med home"><Image src="/brand/mark.png" alt="" width={22} height={22} /></Link>
          <div className="hidden min-w-0 items-center gap-3 text-sm lg:flex">
            <span className="truncate font-medium">{orgName}</span><span aria-hidden className="h-4 w-px bg-border" /><span className="truncate text-muted">{branch}</span>
          </div>
          <div className="mx-auto">
            <Slide label="Quick actions" storeKey="pill" active={pill.find((q) => path === q.href || path.startsWith(q.href + "/"))?.href}
              items={pill.map((q) => ({ key: q.href, label: q.label, href: q.href }))}
              track="flex items-center gap-1 rounded-full bg-ink p-1.5 text-[12.5px] text-[var(--btn-fg)] shadow-[0_14px_30px_-14px_rgba(11,53,88,.6)]"
              itemClass="whitespace-nowrap rounded-full px-4 py-2 font-medium opacity-80 hover:opacity-100" activeClass="!opacity-100 !text-ink"
              thumbClass="rounded-full bg-[var(--btn-fg)] shadow-[0_2px_8px_-2px_rgba(0,0,0,.35)]">
              <button onClick={() => setOpen(true)} aria-label="Open command palette" className="relative z-10 flex items-center gap-2 whitespace-nowrap rounded-full px-4 py-2 opacity-80 transition hover:opacity-100">
                <Search size={14} /><span className="hidden sm:inline">{labels.search}</span><kbd className="hidden rounded-md border border-current/25 px-1.5 text-[10px] opacity-70 lg:inline">Ctrl K</kbd>
              </button>
            </Slide>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/notifications" aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`} className={cn(iconBtn, "relative")}><Bell size={17} />{unread > 0 && <span className="absolute end-0 top-0 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white ring-2 ring-bg">{unread > 9 ? "9+" : unread}</span>}</Link>
            <form action={setLocale} className="hidden sm:block"><button className={cn(iconBtn, "w-auto px-4 text-xs font-medium")} aria-label="Switch language">{labels.language}</button></form>
            <div className="flex items-center gap-2.5 rounded-full bg-surface py-1 pe-4 ps-1 shadow-card">
              <span aria-hidden className="grid size-8 place-items-center rounded-full brand-grad text-xs font-semibold text-white">{initials(userName)}</span>
              <div className="hidden text-start text-xs leading-tight xl:block"><div className="max-w-36 truncate font-medium">{userName}</div><div className="max-w-36 truncate capitalize text-muted">{roles}</div></div>
            </div>
          </div>
        </header>
        <MobileNav items={items} path={path} />
        <main aria-busy={busy} className={cn("flex-1 px-4 pb-24 pt-3 transition-opacity duration-200 md:px-6 md:ps-3", busy && "opacity-60")}><div className="mx-auto max-w-[1480px]">{children}</div></main>
        <footer className="no-print px-6 py-4 text-center text-[11px] text-muted">Elister Med · Your Trusted Family Healthcare Partner in Dubai · Demo environment with synthetic data</footer>
      </div>
      {showChat && <ChatDock />}
      {open && <Palette onClose={() => setOpen(false)} entries={[...items.map((i) => ({ href: i.href, label: i.label })), ...quick]} />}
    </div>
  );
}

function MobileNav({ items, path }: { items: Item[]; path: string }) {
  return (
    <nav aria-label="Mobile" className="no-print flex gap-1.5 overflow-x-auto px-4 pb-2 md:hidden">
      {items.map((i) => (
        <Link key={i.href} href={i.href} aria-current={isActive(path, i.href) ? "page" : undefined} className={cn("shrink-0 rounded-full px-4 py-2 text-xs font-medium", isActive(path, i.href) ? "bg-ink text-[var(--btn-fg)]" : "bg-surface text-muted shadow-card")}>{i.label}</Link>
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
    <div role="dialog" aria-modal="true" aria-label="Command palette" className="fixed inset-0 z-50 grid place-items-start justify-center bg-black/40 p-4 pt-24" onClick={onClose}>
      <div className="panel w-full max-w-lg overflow-hidden rounded-[28px] shadow-[var(--shadow-pop)]" onClick={(e) => e.stopPropagation()}>
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
