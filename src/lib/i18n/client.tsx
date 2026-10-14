"use client";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { dirOf, intlLocale, LOCALE_COOKIE, translate, type Locale } from "./index";

interface I18n { locale: Locale; dir: "ltr" | "rtl"; t: (key: string, vars?: Record<string, string | number>) => string; setLocale: (l: Locale) => void; fmt: Formatters }
interface Formatters { date: (d: string | Date, o?: Intl.DateTimeFormatOptions) => string; number: (n: number, o?: Intl.NumberFormatOptions) => string; money: (n: number, currency?: string) => string }

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const router = useRouter();
  const setLocale = useCallback((l: Locale) => {
    document.cookie = `${LOCALE_COOKIE}=${l}; Path=/; Max-Age=31536000; SameSite=Lax`;
    router.refresh();
  }, [router]);
  const value = useMemo<I18n>(() => {
    const loc = intlLocale(locale);
    return {
      locale, dir: dirOf(locale), setLocale,
      t: (key, vars) => translate(locale, key, vars),
      fmt: {
        // Server (Node ICU) and browser (CLDR) can disagree on punctuation and space characters; normalizing them keeps
        // server-rendered text identical to the client's, so hydration never mismatches.
        // Calendar dates (YYYY-MM-DD) render in UTC so they never shift with the viewer's time zone.
        date: (d, o = { weekday: "short", day: "numeric", month: "short" }) =>
          new Intl.DateTimeFormat(loc, { timeZone: typeof d === "string" && d.length === 10 ? "UTC" : undefined, ...o })
            .format(typeof d === "string" ? new Date(d.length === 10 ? d + "T00:00:00Z" : d) : d).replace(/[,،]/g, "").replace(/[\u202F\u00A0]/g, " ").replace(/\s+at\s+/g, " "),
        number: (n, o) => new Intl.NumberFormat(loc, o).format(n).replace(/[\u202F\u00A0]/g, " "),
        money: (n, currency = "MAD") => new Intl.NumberFormat(loc, { style: "currency", currency, maximumFractionDigits: 0 }).format(n).replace(/[\u202F\u00A0]/g, " "),
      },
    };
  }, [locale, setLocale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error("useI18n outside provider");
  return v;
}
export const useT = () => useI18n().t;
