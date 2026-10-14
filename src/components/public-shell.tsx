"use client";
import type { ReactNode } from "react";
import { Icon } from "./icons";
import { LangSwitch } from "./lang-switch";
import { useI18n } from "@/lib/i18n/client";

export interface PublicRestaurant {
  slug: string; name: string; description: string | null; address: string | null; city: string | null; phone: string | null; email: string | null; website: string | null;
  logoUrl: string | null; coverUrl: string | null; gallery: string[]; brandColor: string; timezone: string; currency: string; locale: string; today: string; maxDate: string;
  minParty: number; maxPartyOnline: number; onlineBookingEnabled: boolean; policy: string | null; cancelDeadlineHours: number; autoConfirm: boolean; waitlistOpen: boolean;
  deposit: null | { perGuest: number; minParty: number; currency: string; collected: boolean };
  services: Array<{ name: string; days: number[]; startTime: string; lastSeating: string }>;
  seatingOptions: Array<{ id: string; name: string; kind: string }>; largestTable: number | null;
}

/** Branded wrapper for every guest-facing page. `dir` follows the language so layouts mirror for Arabic. */
export function PublicShell({ r, children, narrow = false }: { r: Pick<PublicRestaurant, "name" | "brandColor" | "logoUrl" | "coverUrl" | "address" | "city" | "phone"> & { description?: string | null }; children: ReactNode; narrow?: boolean }) {
  const { dir, locale } = useI18n();
  return (
    <div dir={dir} lang={locale} style={{ ["--brand" as string]: r.brandColor }} className="min-h-dvh bg-canvas">
      <header className="relative text-white" style={{ background: r.coverUrl ? `linear-gradient(rgb(20 18 15 / .55), rgb(20 18 15 / .75)), center/cover url(${r.coverUrl})` : `linear-gradient(135deg, #1c1b19, ${r.brandColor})` }}>
        <div className="mx-auto max-w-5xl px-5 pt-4 pb-10 sm:pb-14">
          <div className="flex justify-end"><LangSwitch dark /></div>
          <div className="mt-4 flex items-center gap-4">
            {r.logoUrl && <img src={r.logoUrl} alt="" className="size-16 sm:size-20 rounded-2xl object-cover bg-white/10 border border-white/20" />}
            <div className="min-w-0"><h1 className="text-3xl sm:text-4xl font-semibold leading-tight">{r.name}</h1>
              <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-white/80">
                {(r.address || r.city) && <a className="inline-flex items-center gap-1.5 hover:underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([r.name, r.address, r.city].filter(Boolean).join(", "))}`}><Icon name="pin" size={15} />{[r.address, r.city].filter(Boolean).join(", ")}</a>}
                {r.phone && <a className="inline-flex items-center gap-1.5 hover:underline" href={`tel:${r.phone}`}><Icon name="phone" size={15} /><bdi dir="ltr">{r.phone}</bdi></a>}</p></div>
          </div>
          {r.description && <p className="mt-5 max-w-2xl text-white/85 leading-relaxed">{r.description}</p>}
        </div>
      </header>
      <main className={`mx-auto px-4 sm:px-5 -mt-6 pb-16 ${narrow ? "max-w-xl" : "max-w-5xl"}`}>{children}</main>
      <footer className="text-center text-xs text-muted pb-8">Powered by <b>Fluentra</b></footer>
    </div>
  );
}
