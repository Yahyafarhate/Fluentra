import type { ReactNode } from "react";
import Link from "next/link";
import { Logo } from "./icons";
import { LangSwitch } from "./lang-switch";

export function AuthCard({ title, subtitle, children, footer, wide }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  return (
    <main className="min-h-dvh grid lg:grid-cols-[1fr_minmax(0,560px)]">
      <aside className="hidden lg:flex flex-col justify-between bg-charcoal text-white p-12 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[.07]" style={{ backgroundImage: "radial-gradient(circle at 20% 20%, #d9b878 0, transparent 40%), radial-gradient(circle at 80% 90%, #a8803f 0, transparent 45%)" }} />
        <Link href="/" className="relative"><Logo light /></Link>
        <div className="relative max-w-md">
          <p className="font-display text-4xl leading-tight">Every table, every guest, every service — in one calm place.</p>
          <p className="mt-5 text-white/60 text-sm leading-relaxed">Reservations, live floor plan, waitlist, guest memory and campaigns for restaurants, hotels, rooftops and lounges across Morocco and beyond.</p>
        </div>
        <p className="relative text-xs text-white/40">© Fluentra — temporary brand name</p>
      </aside>
      <section className="flex flex-col px-5 sm:px-10 py-8">
        <div className="flex items-center justify-between lg:justify-end mb-8"><Link href="/" className="lg:hidden"><Logo /></Link><LangSwitch /></div>
        <div className={`m-auto w-full ${wide ? "max-w-lg" : "max-w-sm"} animate-in`}>
          <h1 className="text-3xl font-semibold">{title}</h1>
          {subtitle && <p className="text-muted mt-2 text-sm">{subtitle}</p>}
          <div className="mt-7">{children}</div>
          {footer && <div className="mt-6 text-sm text-center text-muted">{footer}</div>}
        </div>
      </section>
    </main>
  );
}
