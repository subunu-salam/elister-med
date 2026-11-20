import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Poppins, IBM_Plex_Sans_Arabic, Noto_Sans_Malayalam } from "next/font/google";
import "./globals.css";

const latin = Poppins({ variable: "--font-poppins", subsets: ["latin"], weight: ["300", "400", "500", "600", "700"], display: "swap" });
const malayalam = Noto_Sans_Malayalam({ variable: "--font-ml", subsets: ["malayalam"], weight: ["400", "500", "600", "700"], display: "swap" });
const arabic = IBM_Plex_Sans_Arabic({ variable: "--font-plex-arabic", subsets: ["arabic"], weight: ["400", "500", "600", "700"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "Elister Med", template: "%s · Elister Med" },
  description: "Elister Med — your trusted family healthcare partner in Dubai. Clinic management platform.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Elister", statusBarStyle: "black-translucent" },
  icons: { apple: "/brand/apple-touch-icon.png" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: [{ media: "(prefers-color-scheme: light)", color: "#e9edf4" }, { media: "(prefers-color-scheme: dark)", color: "#0d1017" }] };

// Applies the saved theme before first paint to avoid a light/dark flash.
// Chrome/Edge/Android fire "beforeinstallprompt" very early, often before the app's JS loads; keep it so the Install button can use it.
const installScript = `window.addEventListener("beforeinstallprompt",function(e){e.preventDefault();window.__bip=e;window.dispatchEvent(new Event("elister:installable"))});`;
const themeScript = `try{var t=localStorage.getItem("theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${latin.variable} ${arabic.variable} ${malayalam.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <script dangerouslySetInnerHTML={{ __html: installScript }} />
      </head>
      <body className="min-h-full font-sans">
        {/* All routes read cookies/session/db at request time; they stream in behind this boundary. */}
        <Suspense fallback={<div className="p-8"><div className="skeleton h-6 w-48" /></div>}>{children}</Suspense>
      </body>
    </html>
  );
}
