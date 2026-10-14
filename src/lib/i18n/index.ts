import { fr } from "./fr";
import { ar } from "./ar";

export const LOCALES = ["fr", "en", "ar"] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_COOKIE = "fl_locale";
export const LOCALE_LABELS: Record<Locale, string> = { fr: "Français", en: "English", ar: "العربية" };
export const isLocale = (v: unknown): v is Locale => typeof v === "string" && (LOCALES as readonly string[]).includes(v);
export const dirOf = (l: Locale) => (l === "ar" ? "rtl" : "ltr");

const dicts: Record<Locale, Record<string, string>> = { en: {}, fr, ar };

/** English text is the key. Missing translations fall back to the English text itself. */
export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  let s = dicts[locale][key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] === undefined ? `{${k}}` : String(vars[k])));
  return s;
}

export const intlLocale = (l: Locale) => (l === "ar" ? "ar-MA-u-nu-latn" : l === "en" ? "en-GB" : "fr-FR");
export { fr, ar };
