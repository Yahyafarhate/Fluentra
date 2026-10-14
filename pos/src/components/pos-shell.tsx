"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { Badge, Button, LangSwitch, Loading, Logo } from "@/components/ui";
import { authCall } from "@/lib/client/api";
import { useOnline } from "@/lib/client/hooks";
import type { Me } from "@/lib/client/types";
import { useT } from "@/lib/i18n";

export function useMe(redirect = "/pos/login") {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => { authCall<Me>("GET", "/me").then(setMe).catch(() => { window.location.href = redirect; }); }, [redirect]);
  return me;
}

export async function signOut(to = "/pos/login") { try { await authCall("POST", "/logout"); } finally { window.location.href = to; } }

export function PosShell({ me, children, active }: { me: Me | null; children: ReactNode; active?: "floor" | "orders" | "cash" }) {
  const t = useT();
  const online = useOnline();
  if (!me) return <div className="min-h-dvh bg-canvas"><Loading /></div>;
  const nav = [
    { id: "floor", href: "/pos", label: t("Floor") },
    { id: "orders", href: "/pos/orders", label: t("Orders") },
    ...(me.permissions.includes("cash.session") ? [{ id: "cash", href: "/pos/cash", label: t("Cash") }] : []),
  ];
  return (
    <div className="min-h-dvh flex flex-col bg-canvas">
      <header className="h-14 bg-charcoal text-white flex items-center gap-3 px-3 sticky top-0 z-30 no-print">
        <Link href="/pos" aria-label="Home"><Logo compact /></Link>
        <nav className="flex gap-1">{nav.map((n) => <Link key={n.id} href={n.href} className={`px-3 h-9 grid place-items-center rounded-lg text-sm ${active === n.id ? "bg-white/15" : "hover:bg-white/10"}`}>{n.label}</Link>)}
          {me.permissions.includes("kds.use") && <Link href="/kds" className="px-3 h-9 grid place-items-center rounded-lg text-sm hover:bg-white/10">KDS</Link>}</nav>
        <div className="ml-auto flex items-center gap-2 text-sm">
          {online ? <Badge tone="ok">{t("Online")}</Badge> : <Badge tone="bad">{t("Offline — changes are NOT saved")}</Badge>}
          <span className="hidden sm:inline text-white/70">{me.employee.name}</span>
          <LangSwitch />
          <Button size="sm" variant="ghost" className="text-white hover:bg-white/10" onClick={() => signOut()}>{t("Lock")}</Button>
        </div>
      </header>
      <main className="flex-1 min-h-0">{children}</main>
    </div>
  );
}
