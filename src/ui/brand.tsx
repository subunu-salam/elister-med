import Image from "next/image";
import type { ReactNode } from "react";
import { cn } from "@/ui/kit";
import { RouteIcon } from "@/ui/shell/RouteIcon";

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
    <div className="hero-grad relative mb-6 overflow-hidden rounded-[32px] p-7 text-white sm:p-8">
      <span aria-hidden className="pointer-events-none absolute -end-8 top-1/2 -translate-y-1/2 text-white opacity-[0.1]"><RouteIcon size={230} strokeWidth={1} /></span>
      <div className="relative flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && <div className="mb-3 inline-flex rounded-full bg-white/20 px-3.5 py-1 text-xs font-medium text-white">{eyebrow}</div>}
          <h1 className="text-[34px] font-light leading-[1.1] tracking-tight text-white">{title}</h1>
          <p className="mt-2 text-sm text-white/80">{BRAND.tagline}</p>
        </div>
        <Image src="/brand/logo-header.png" alt="Elister Med" width={227} height={109} className="h-12 w-auto" />
      </div>
      {children && <div className="relative mt-5 flex max-w-3xl flex-wrap gap-3">{children}</div>}
    </div>
  );
}
