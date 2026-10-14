"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fr } from "./fr";

export type Locale = "fr" | "en" | "ar";
/** English text is the key. Arabic/RTL: the layout switches `dir` and uses logical properties; the Arabic dictionary is not written yet (falls back to English). */
const dicts: Record<Locale, Record<string, string>> = { fr, en: {}, ar: {} };

interface Ctx { locale: Locale; setLocale: (l: Locale) => void; t: (key: string, vars?: Record<string, string | number>) => string }
const I18n = createContext<Ctx>({ locale: "en", setLocale: () => undefined, t: (k) => k });

const interpolate = (s: string, vars?: Record<string, string | number>) => (vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)) : s);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("fr");
  useEffect(() => { try { const l = localStorage.getItem("cp_locale") as Locale | null; if (l && l in dicts) setLocaleState(l); } catch { /* unavailable */ } }, []);
  useEffect(() => { document.documentElement.lang = locale; document.documentElement.dir = locale === "ar" ? "rtl" : "ltr"; }, [locale]);
  const setLocale = useCallback((l: Locale) => { setLocaleState(l); try { localStorage.setItem("cp_locale", l); } catch { /* ignore */ } }, []);
  const t = useCallback((key: string, vars?: Record<string, string | number>) => interpolate(dicts[locale][key] ?? key, vars), [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18n.Provider value={value}>{children}</I18n.Provider>;
}
export const useT = () => useContext(I18n).t;
export const useLocale = () => { const c = useContext(I18n); return { locale: c.locale, setLocale: c.setLocale }; };
