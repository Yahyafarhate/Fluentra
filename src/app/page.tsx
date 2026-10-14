import Link from "next/link";
import { Icon, Logo, type IconName } from "@/components/icons";
import { LangSwitch } from "@/components/lang-switch";
import { getLocale } from "@/lib/i18n/server";
import { translate } from "@/lib/i18n";
import { env } from "@/lib/env";

export default async function Home() {
  const locale = await getLocale();
  const t = (k: string) => translate(locale, k);
  const features: Array<[IconName, string, string]> = [
    ["calendar", "Reservations that never double-book", "A transactional availability engine checks capacity, table fit, buffers and service hours on the server — even under simultaneous bookings."],
    ["floor", "A live, visual floor plan", "Drag tables, combine them for groups, seat in two taps and release tables when guests leave."],
    ["users", "Guest memory that serves hospitality", "Allergies, VIP status, occasions and history surface before arrival — with consent and privacy built in."],
    ["clock", "Waitlist with honest estimates", "Wait times are computed from real table availability and labelled as estimates, never promises."],
    ["megaphone", "Retention without the guesswork", "Consent-aware campaigns. Delivery, engagement and attributable bookings are reported separately."],
    ["building", "Multi-location, multi-tenant", "Role-based access, per-location permissions, audit logs and strict data isolation between businesses."],
  ];
  return (
    <div className="min-h-dvh">
      <header className="mx-auto max-w-6xl flex items-center justify-between px-5 h-16">
        <Logo />
        <div className="flex items-center gap-2"><LangSwitch /><Link href="/login" className="px-3 h-9 inline-flex items-center rounded-lg text-sm font-medium hover:bg-sunken">{t("Log in")}</Link>
          <Link href="/signup" className="px-4 h-9 inline-flex items-center rounded-lg bg-charcoal text-white text-sm font-medium hover:bg-charcoal-3">{t("Start a free trial")}</Link></div>
      </header>
      <section className="mx-auto max-w-6xl px-5 pt-14 pb-16 grid lg:grid-cols-[1.15fr_.85fr] gap-12 items-center">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full bg-gold-soft text-gold-strong text-xs font-medium px-3 py-1"><Icon name="sparkle" size={14} />Restaurants · Hotels · Rooftops · Lounges</p>
          <h1 className="mt-5 text-4xl sm:text-5xl lg:text-[3.4rem] leading-[1.08] font-semibold">The reservation &amp; guest platform built for modern hospitality.</h1>
          <p className="mt-5 text-lg text-ink-2 max-w-xl">Take bookings, run the floor, remember every guest and bring them back — in French, Arabic and English, on any device.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/signup" className="h-12 px-6 inline-flex items-center rounded-xl bg-charcoal text-white font-medium hover:bg-charcoal-3">{t("Start a free trial")}</Link>
            {!env.isProd && <Link href="/book/le-riad-atlas" className="h-12 px-6 inline-flex items-center rounded-xl border border-line-strong bg-surface font-medium hover:bg-sunken">See a public booking page</Link>}
          </div>
        </div>
        <div className="relative rounded-3xl bg-charcoal p-6 text-white shadow-[var(--shadow-pop)]">
          <div className="flex items-center justify-between text-xs text-white/50"><span>Saturday service</span><span className="text-gold">● live</span></div>
          <div className="mt-4 grid grid-cols-3 gap-2.5">
            {[["Reservations", "42"], ["Covers", "168"], ["Seated", "11"]].map(([k, v]) => <div key={k} className="rounded-xl bg-white/6 p-3"><p className="text-[11px] text-white/50">{k}</p><p className="text-2xl font-semibold mt-0.5">{v}</p></div>)}
          </div>
          <div className="mt-4 grid grid-cols-4 gap-2">
            {[["M1","ok"],["M2","busy"],["M3","res"],["M4","ok"],["M5","busy"],["M6","busy"],["M7","clean"],["M8","res"]].map(([n, s]) => (
              <div key={n} className={`rounded-lg h-14 grid place-items-center text-xs font-medium ${s === "ok" ? "bg-ok/25 text-[#9fd8b8]" : s === "busy" ? "bg-violet/35 text-[#cbbbe9]" : s === "res" ? "bg-info/30 text-[#a6cde4]" : "bg-warn/30 text-[#f1d089]"}`}>{n}</div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-white/40">Illustration — your real floor plan is fully editable.</p>
        </div>
      </section>
      <section className="bg-surface border-y border-line">
        <div className="mx-auto max-w-6xl px-5 py-16 grid sm:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map(([icon, title, text]) => (
            <div key={title}><div className="size-10 rounded-xl bg-gold-soft text-gold-strong grid place-items-center"><Icon name={icon} /></div><h3 className="mt-4 text-lg font-semibold">{title}</h3><p className="mt-1.5 text-sm text-ink-2 leading-relaxed">{text}</p></div>
          ))}
        </div>
      </section>
      <footer className="mx-auto max-w-6xl px-5 py-10 text-sm text-muted flex flex-wrap justify-between gap-3"><span>© Fluentra (temporary brand name). SevenRooms is a functional reference only.</span><span>Casablanca · Marrakech · Paris</span></footer>
    </div>
  );
}
