import en from "./en.json";
import ar from "./ar.json";

export type Locale = "en" | "ar";
export const LOCALES: Locale[] = ["en", "ar"];
const dict: Record<Locale, Record<string, string>> = { en, ar };

export const dirOf = (l: Locale) => (l === "ar" ? "rtl" : "ltr");
export const normalizeLocale = (v?: string): Locale => (v === "ar" ? "ar" : "en");
/** Missing keys fall back to English, then to the key itself. */
export const t = (l: Locale, key: string): string => dict[l][key] ?? dict.en[key] ?? key;
