"use client";
import Link from "next/link";
import { Logo, LangSwitch } from "@/components/ui";
import { useT } from "@/lib/i18n";

export default function Home() {
  const t = useT();
  const tiles = [
    { href: "/pos/login", title: t("POS terminal"), body: t("Floor plan, orders, bills and payments for servers and cashiers.") },
    { href: "/pos/login?kds=1", title: t("Kitchen display"), body: t("Tickets by station with timers, allergies and recall.") },
    { href: "/admin/login", title: t("Back office"), body: t("Menu, floor, staff, reports, end of day and Fluentra sync.") },
  ];
  return (
    <main className="min-h-dvh bg-canvas">
      <header className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between"><Logo /><LangSwitch /></header>
      <section className="max-w-5xl mx-auto px-4 pt-10 pb-8">
        <h1 className="text-4xl sm:text-5xl font-semibold leading-tight max-w-3xl">{t("The point of sale built for the pace of service.")}</h1>
        <p className="mt-4 text-lg text-ink-2 max-w-2xl">{t("Every table, order, bill and payment recorded once, reconciled to the centime — and shared with Fluentra without ever slowing the floor down.")}</p>
        <div className="mt-8 grid sm:grid-cols-3 gap-4">
          {tiles.map((x) => (
            <Link key={x.href} href={x.href} className="group rounded-2xl bg-surface border border-line p-5 shadow-card hover:border-gold transition-colors">
              <div className="font-display text-xl font-semibold group-hover:text-gold-strong">{x.title} →</div>
              <p className="mt-2 text-sm text-ink-2">{x.body}</p>
            </Link>
          ))}
        </div>
        <p className="mt-8 text-sm text-muted">{t("New restaurant?")} <Link href="/signup" className="text-gold-strong underline">{t("Create your organization")}</Link></p>
      </section>
    </main>
  );
}
