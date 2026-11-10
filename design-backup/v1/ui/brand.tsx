import Image from "next/image";
import type { ReactNode } from "react";
import { cn } from "@/ui/kit";

export const BRAND = {
  name: "Elister Med",
  nameAr: "اليستر ميد",
  tagline: "Your Trusted Family Healthcare Partner in Dubai",
  taglineAr: "شريكك الموثوق لرعاية أسرتك في دبي",
  website: "www.elistermed.ae",
  email: "info@elistermed.ae",
  phones: ["+971 54 232 0542", "+971 4 283 8398"],
  address: "Al Noor Building, Al Qusais Industrial Area 3, Al Qusais, Dubai",
} as const;

/** Full-colour logo for light surfaces. */
export function Logo({ className, priority }: { className?: string; priority?: boolean }) {
  return <Image src="/brand/logo-footer.png" alt="Elister Med" width={235} height={117} priority={priority} className={cn("h-10 w-auto dark:hidden", className)} />;
}
/** White logo for dark/brand surfaces. In dark theme the full-colour logo is also swapped for this one. */
export function LogoWhite({ className, priority }: { className?: string; priority?: boolean }) {
  return <Image src="/brand/logo-header.png" alt="Elister Med" width={227} height={109} priority={priority} className={cn("h-10 w-auto", className)} />;
}
/** Picks the right variant for the current theme on a page background. */
export function LogoAuto({ className, priority }: { className?: string; priority?: boolean }) {
  return (
    <>
      <Logo className={className} priority={priority} />
      <LogoWhite className={cn("hidden dark:block", className)} priority={priority} />
    </>
  );
}
/** Leaf mark only (collapsed sidebar, avatars). */
export function Mark({ className, size = 32 }: { className?: string; size?: number }) {
  return <Image src="/brand/mark.png" alt="Elister Med" width={size} height={size} className={className} />;
}

/** Brand banner for module landing pages: white logo on the Elister gradient with the clinic's tagline. */
export function BrandBanner({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return (
    <div className="brand-grad page-in relative mb-5 overflow-hidden rounded-2xl p-5 text-white shadow-[var(--shadow-pop)] sm:p-6">
      <div aria-hidden className="pointer-events-none absolute -end-10 -top-16 size-56 rounded-full bg-white/10 blur-2xl" />
      <Image src="/brand/mark.png" alt="" aria-hidden width={210} height={210} className="pointer-events-none absolute -end-8 top-1/2 size-52 -translate-y-1/2 opacity-[0.13]" />
      <div aria-hidden className="accent-grad absolute inset-x-0 bottom-0 h-1 opacity-80" />
      <div className="relative flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-100">{eyebrow}</div>}
          <h1 className="text-2xl font-semibold tracking-tight text-white">{title}</h1>
          <p className="mt-1 text-sm text-white/75">{BRAND.tagline}</p>
        </div>
        <Image src="/brand/logo-header.png" alt="Elister Med" width={227} height={109} className="h-12 w-auto opacity-95" />
      </div>
      {children && <div className="relative mt-4 flex flex-wrap gap-3">{children}</div>}
    </div>
  );
}
