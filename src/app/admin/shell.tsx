"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon, Logo } from "@/components/icons";
import { Badge, cx } from "@/components/ui";
import { LangSwitch } from "@/components/lang-switch";
import { api } from "@/lib/client/api";

const NAV = [{ href: "/admin", label: "Overview", icon: "dashboard" as const }, { href: "/admin/organizations", label: "Organizations", icon: "building" as const }, { href: "/admin/audit", label: "Audit log", icon: "shield" as const }];

export function AdminShell({ name, children }: { name: string; children: ReactNode }) {
  const path = usePathname(); const router = useRouter();
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="bg-charcoal text-white lg:sticky lg:top-0 lg:h-dvh px-4 py-4 lg:py-5 flex lg:flex-col gap-4 items-center lg:items-stretch overflow-x-auto">
        <div className="px-2 lg:mb-4 flex items-center gap-3"><Logo light /><Badge tone="gold">Platform</Badge></div>
        <nav className="flex lg:flex-col gap-1 flex-1">{NAV.map((n) => { const a = n.href === "/admin" ? path === n.href : path.startsWith(n.href); return <Link key={n.href} href={n.href} className={cx("flex items-center gap-3 rounded-lg px-3 h-10 text-sm font-medium whitespace-nowrap", a ? "bg-white/10 text-white" : "text-white/65 hover:text-white hover:bg-white/5")}><Icon name={n.icon} size={18} className={a ? "text-gold" : ""} />{n.label}</Link>; })}</nav>
        <div className="flex items-center gap-2 text-sm"><span className="text-white/60 hidden lg:inline truncate">{name}</span><LangSwitch dark /><button className="p-2 rounded-lg hover:bg-white/10 text-white/70" aria-label="Log out" onClick={async () => { await api.post("/api/auth/logout"); router.push("/login"); router.refresh(); }}><Icon name="logout" size={17} /></button></div>
      </aside>
      <main className="px-4 sm:px-6 lg:px-8 py-6 max-w-[1400px] w-full">{children}</main>
    </div>
  );
}
