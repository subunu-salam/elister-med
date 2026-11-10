import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Plus_Jakarta_Sans, IBM_Plex_Sans_Arabic } from "next/font/google";
import "./globals.css";

const latin = Plus_Jakarta_Sans({ variable: "--font-plus-jakarta", subsets: ["latin"], display: "swap" });
const arabic = IBM_Plex_Sans_Arabic({ variable: "--font-plex-arabic", subsets: ["arabic"], weight: ["400", "500", "600", "700"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "Elister Med", template: "%s · Elister Med" },
  description: "Elister Med — your trusted family healthcare partner in Dubai. Clinic management platform.",
};
export const viewport: Viewport = { themeColor: [{ media: "(prefers-color-scheme: light)", color: "#0b4a7e" }, { media: "(prefers-color-scheme: dark)", color: "#06161f" }] };

// Applies the saved theme before first paint to avoid a light/dark flash.
const themeScript = `try{var t=localStorage.getItem("theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${latin.variable} ${arabic.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full font-sans">
        {/* All routes read cookies/session/db at request time; they stream in behind this boundary. */}
        <Suspense fallback={<div className="p-8"><div className="skeleton h-6 w-48" /></div>}>{children}</Suspense>
      </body>
    </html>
  );
}
