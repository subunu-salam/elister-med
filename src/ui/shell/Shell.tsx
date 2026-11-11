"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bell, Command, LogOut, Moon, Search, Sun } from "lucide-react";
import { cn } from "@/ui/kit";
import { ICONS, type IconKey } from "@/ui/shell/icons";
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
const iconBtn = "panel grid size-12 place-items-center rounded-full text-fg transition hover:text-primary";

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
  const [hello, setHello] = useState("");
  const [today, setToday] = useState("");
  const firstName = userName.replace(/\(.*?\)/g, "").trim().split(" ")[0] || userName;

  /* Browser-only state (theme class) can only be read after mount. */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    document.documentElement.dir = dir;
    document.documentElement.lang = locale;
    setDark(document.documentElement.classList.contains("dark"));
    const h = Number(new Date().toLocaleString("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", hour12: false }));
    setHello(h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening");
    setToday(new Date().toLocaleDateString(locale === "ar" ? "ar-AE" : "en-GB", { timeZone: "Asia/Dubai", weekday: "long", day: "numeric", month: "long", year: "numeric" }));
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

  return (
    <div dir={dir} lang={locale} className="flex min-h-screen">
      <div aria-hidden className={cn("no-print pointer-events-none fixed inset-x-0 top-0 z-[60] h-[3px] origin-left brand-grad transition-opacity duration-300", busy ? "nav-bar opacity-100" : "opacity-0")} />
      <aside className="no-print relative hidden w-[100px] shrink-0 md:block">
        <div className="rail side-glass fixed inset-y-4 start-4 z-30 flex flex-col overflow-hidden rounded-[40px]">
          <Link href="/dashboard" aria-label="Elister Med home" className="flex shrink-0 items-center gap-3 px-3 pb-4 pt-3">
            <span className="logo-capsule grid h-[92px] w-[52px] shrink-0 place-items-center rounded-full"><Image src="/brand/mark.png" alt="" width={28} height={28} priority className="drop-shadow" /></span>
            <span className="rail-label min-w-0"><span className="block truncate text-sm font-semibold text-fg">{orgName}</span><span className="block truncate text-xs text-muted">{branch}</span></span>
          </Link>
          <nav ref={navRef} aria-label="Primary" className="rail-nav relative flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3">
            <span aria-hidden className={cn("rail-dot pointer-events-none absolute start-3 size-[52px] rounded-full", dot.ready ? "opacity-100" : "opacity-0")} style={{ top: dot.y }} />
            {grouped.map(({ g, rows }, gi) => (
              <Fragment key={g}>
                {gi > 0 && <div aria-hidden className="mx-4 my-2 h-px bg-border" />}
                {rows.map((i) => {
                  const Icon = ICONS[i.icon];
                  const active = pending ? pending === i.href : isActive(path, i.href);
                  return (
                    <Link key={i.href} href={i.href} title={i.label} aria-current={active ? "page" : undefined} onClick={() => setPending(i.href)}
                      className={cn("group relative z-10 my-0.5 flex h-[52px] items-center gap-3 rounded-full text-sm transition-colors", active ? "font-medium text-fg" : "text-[var(--rail-fg)] hover:text-fg")}>
                      <span className={cn("grid size-[52px] shrink-0 place-items-center rounded-full transition-all duration-300", active ? "text-[var(--btn-fg)]" : "bg-surface shadow-[0_0_0_1px_var(--border)] group-hover:shadow-[0_0_0_1.5px_var(--primary)] group-hover:text-primary", active && !dot.ready && "bg-[var(--btn-bg)]")}><Icon size={20} strokeWidth={1.7} /></span>
                      <span className="rail-label truncate pe-4">{i.label}</span>
                    </Link>
                  );
                })}
              </Fragment>
            ))}
          </nav>
          <div className="flex shrink-0 flex-col items-start gap-1 border-t border-border px-3 py-3">
            <button onClick={toggleTheme} aria-label="Toggle theme" className="group flex h-[52px] w-full items-center gap-3 rounded-full text-sm text-[var(--rail-fg)] hover:text-fg">
              <span className="grid size-[52px] shrink-0 place-items-center rounded-full bg-surface shadow-[0_0_0_1px_var(--border)] group-hover:text-primary">{dark ? <Sun size={19} strokeWidth={1.7} /> : <Moon size={19} strokeWidth={1.7} />}</span>
              <span className="rail-label">{dark ? "Light mode" : "Dark mode"}</span>
            </button>
            <form action={signOut} className="w-full">
              <button aria-label={labels.signOut} className="group flex h-[52px] w-full items-center gap-3 rounded-full text-sm text-[var(--rail-fg)] hover:text-danger">
                <span className="grid size-[52px] shrink-0 place-items-center rounded-full bg-surface shadow-[0_0_0_1px_var(--border)]"><LogOut size={19} strokeWidth={1.7} /></span>
                <span className="rail-label">{labels.signOut}</span>
              </button>
            </form>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col md:pe-2">
        <header className="topbar no-print sticky top-0 z-20 flex items-center gap-3 px-4 py-4 md:px-7 md:ps-4">
          <Link href="/dashboard" className="logo-capsule grid h-12 w-9 shrink-0 place-items-center rounded-full md:hidden" aria-label="Elister Med home"><Image src="/brand/mark.png" alt="" width={20} height={20} /></Link>
          <div className="min-w-0">
            <div className="truncate text-[19px] font-semibold tracking-tight md:text-[22px]">{hello ? `${hello}, ${firstName}` : firstName} <span aria-hidden>👋</span></div>
            <div className="hidden truncate text-xs text-muted sm:block">{today}{branch ? ` · ${branch}` : ""}</div>
          </div>
          <button onClick={() => setOpen(true)} aria-label="Open command palette" className="panel ms-auto hidden h-12 w-full max-w-sm items-center gap-3 rounded-full px-5 text-sm text-muted transition hover:text-fg lg:flex xl:max-w-md">
            <Search size={17} /><span className="flex-1 text-start">{labels.search}…</span><kbd className="rounded-md border border-border px-1.5 py-0.5 text-[10px]">Ctrl K</kbd>
          </button>
          <div className="ms-auto flex items-center gap-2 lg:ms-0">
            <button onClick={() => setOpen(true)} aria-label="Search" className={cn(iconBtn, "lg:hidden")}><Search size={17} /></button>
            <div className="panel flex items-center gap-1 rounded-full p-1.5">
              <Link href="/notifications" aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`} className="relative grid size-10 place-items-center rounded-full text-fg transition hover:bg-surface-2"><Bell size={18} />{unread > 0 && <span className="absolute end-1 top-1 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white ring-2 ring-surface">{unread > 9 ? "9+" : unread}</span>}</Link>
              <form action={setLocale}><button className="grid h-10 min-w-10 place-items-center rounded-full px-2 text-xs font-semibold text-fg transition hover:bg-surface-2" aria-label="Switch language">{labels.language}</button></form>
              <div className="flex items-center gap-2.5 ps-1 pe-1 xl:pe-3">
                <span aria-hidden className="grid size-10 place-items-center rounded-full brand-grad text-xs font-semibold text-white ring-2 ring-white">{initials(userName)}</span>
                <div className="hidden text-start text-xs leading-tight xl:block"><div className="max-w-36 truncate font-medium">{userName}</div><div className="max-w-36 truncate capitalize text-muted">{roles}</div></div>
              </div>
            </div>
          </div>
        </header>
        <MobileNav items={items} path={path} />
        <main aria-busy={busy} className={cn("flex-1 px-4 pb-24 pt-2 transition-opacity duration-200 md:px-7 md:ps-4", busy && "opacity-60")}><div className="mx-auto max-w-[1480px]">{children}</div></main>
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
    <div role="dialog" aria-modal="true" aria-label="Command palette" className="fixed inset-0 z-50 grid place-items-start justify-center bg-[#0b3558]/30 p-4 pt-24 backdrop-blur-sm" onClick={onClose}>
      <div className="panel w-full max-w-xl overflow-hidden rounded-[30px] !bg-surface shadow-[var(--shadow-pop)]" onClick={(e) => e.stopPropagation()}>
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
