"use client";
import { useI18n } from "@/lib/i18n/client";
import { LOCALES, LOCALE_LABELS } from "@/lib/i18n";
import { Icon } from "./icons";

export function LangSwitch({ dark = false }: { dark?: boolean }) {
  const { locale, setLocale } = useI18n();
  return (
    <label className={`inline-flex items-center gap-1.5 rounded-lg px-2 h-9 text-sm cursor-pointer ${dark ? "text-white/80 hover:bg-white/10" : "text-ink-2 hover:bg-sunken"}`}>
      <Icon name="globe" size={16} />
      <span className="sr-only">Language</span>
      <select value={locale} onChange={(e) => setLocale(e.target.value as typeof locale)} className="bg-transparent outline-none cursor-pointer appearance-none pe-1" aria-label="Language">
        {LOCALES.map((l) => <option key={l} value={l} className="text-ink">{LOCALE_LABELS[l]}</option>)}
      </select>
    </label>
  );
}
