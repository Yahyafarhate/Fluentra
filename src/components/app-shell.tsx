"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon, Logo, type IconName } from "./icons";
import { Avatar, Badge, Dialog, IconButton, cx } from "./ui";
import { LangSwitch } from "./lang-switch";
import { useI18n } from "@/lib/i18n/client";
import { api } from "@/lib/client/api";
import type { Me } from "@/server/me";
import type { Permission } from "@/lib/rbac";

interface AppCtx {
  me: Me;
  can: (p: Permission) => boolean;
  hasFeature: (f: string) => boolean;
  locationId: string | null;
  location: Me["locations"][number] | null;
  setLocationId: (id: string) => void;
  /** today's date in the selected restaurant's time zone (resolved by the database), null while loading */
  today: string | null;
}
const Ctx = createContext<AppCtx | null>(null);
export const useApp = () => { const c = useContext(Ctx); if (!c) throw new Error("AppShell missing"); return c; };

const NAV: Array<{ href: string; label: string; icon: IconName; perm: Permission; mobile?: boolean }> = [
  { href: "/app/dashboard", label: "Dashboard", icon: "dashboard", perm: "dashboard.view", mobile: true },
  { href: "/app/reservations", label: "Reservations", icon: "calendar", perm: "reservations.read", mobile: true },
  { href: "/app/floor", label: "Floor plan", icon: "floor", perm: "floor.view", mobile: true },
  { href: "/app/waitlist", label: "Waitlist", icon: "clock", perm: "waitlist.manage", mobile: true },
  { href: "/app/guests", label: "Guests", icon: "users", perm: "customers.read", mobile: true },
  { href: "/app/marketing", label: "Marketing", icon: "megaphone", perm: "marketing.manage" },
  { href: "/app/automations", label: "Automations", icon: "zap", perm: "automations.manage" },
  { href: "/app/analytics", label: "Analytics", icon: "chart", perm: "analytics.view" },
  { href: "/app/team", label: "Team", icon: "shield", perm: "team.manage" },
  { href: "/app/settings", label: "Settings", icon: "settings", perm: "settings.manage" },
  { href: "/app/billing", label: "Billing", icon: "card", perm: "billing.manage" },
];

export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const [locationId, setLoc] = useState<string | null>(me.locations[0]?.id ?? null);
  const [today, setToday] = useState<string | null>(null);

  useEffect(() => { try { const s = localStorage.getItem("fl_loc"); if (s && me.locations.some((l) => l.id === s)) setLoc(s); } catch { /* storage unavailable */ } }, [me.locations]);
  useEffect(() => setMenu(false), [pathname]);
  useEffect(() => {
    if (!locationId) return;
    setToday(null);
    api.get<{ date: string }>(`/api/v1/today?locationId=${locationId}`).then((r) => setToday(r.date)).catch(() => undefined);
  }, [locationId]);
  const setLocationId = useCallback((id: string) => { setLoc(id); try { localStorage.setItem("fl_loc", id); } catch { /* ignore */ } }, []);

  const value = useMemo<AppCtx>(() => ({
    me, can: (p) => me.permissions.includes(p), hasFeature: (f) => me.features.includes(f),
    locationId, location: me.locations.find((l) => l.id === locationId) ?? null, setLocationId, today,
  }), [me, locationId, setLocationId, today]);

  const items = NAV.filter((n) => value.can(n.perm));
  const trialDays = me.organization.status === "trial" && me.trialEndsAt ? Math.ceil((new Date(me.trialEndsAt).getTime() - Date.now()) / 86400000) : null;

  async function logout() { await api.post("/api/auth/logout"); router.push("/login"); router.refresh(); }

  const navList = (compact = false) => (
    <nav className="flex flex-col gap-0.5" aria-label="Main">
      {items.map((n) => {
        const active = pathname === n.href || pathname.startsWith(n.href + "/");
        return (
          <Link key={n.href} href={n.href} title={t(n.label)} className={cx("flex items-center gap-3 rounded-lg px-3 h-10 text-sm font-medium transition", !compact && "lg:justify-center xl:justify-start", active ? "bg-white/10 text-white" : "text-white/65 hover:text-white hover:bg-white/5", compact && "h-11")} aria-current={active ? "page" : undefined}>
            <Icon name={n.icon} size={18} className={active ? "text-gold" : ""} /><span className={compact ? "" : "lg:sr-only xl:not-sr-only"}>{t(n.label)}</span>
          </Link>
        );
      })}
    </nav>
  );

  const user = (
    <div className="flex items-center gap-3 p-3 rounded-xl bg-white/5 lg:flex-col lg:p-2 xl:flex-row xl:p-3">
      <Avatar name={me.user.name} size={34} />
      <div className="min-w-0 flex-1 lg:hidden xl:block"><p className="text-sm text-white truncate">{me.user.name}</p><p className="text-xs text-white/50 truncate">{t(me.role.replace("_", " ").replace(/^./, (c) => c.toUpperCase()))}</p></div>
      <button onClick={logout} aria-label={t("Log out")} title={t("Log out")} className="text-white/60 hover:text-white p-1.5 rounded-lg hover:bg-white/10"><Icon name="logout" size={17} /></button>
    </div>
  );

  return (
    <Ctx.Provider value={value}>
      <div className="min-h-dvh lg:grid lg:grid-cols-[72px_minmax(0,1fr)] xl:grid-cols-[256px_minmax(0,1fr)]">
        <aside className="hidden lg:flex flex-col bg-charcoal px-3 xl:px-4 py-5 sticky top-0 h-dvh no-print">
          <Link href="/app" className="px-2 mb-6"><span className="xl:hidden"><Logo light compact /></span><span className="hidden xl:inline"><Logo light /></span></Link>
          <div className="px-2 mb-4 hidden xl:block"><p className="text-[11px] uppercase tracking-wider text-white/40">{t("Organization")}</p><p className="text-sm text-white/90 truncate">{me.organization.name}</p></div>
          <div className="flex-1 overflow-y-auto scroll-thin -mx-1 px-1">{navList()}</div>
          <div className="mt-4">{user}</div>
        </aside>

        <div className="min-w-0 flex flex-col pb-20 lg:pb-0">
          <header className="sticky top-0 z-30 bg-canvas/85 backdrop-blur border-b border-line no-print">
            <div className="flex items-center gap-2 px-4 sm:px-6 lg:px-8 h-14">
              <IconButton icon="menu" label={t("Menu")} className="lg:hidden" onClick={() => setMenu(true)} />
              <Link href="/app" className="lg:hidden shrink-0"><span className="sm:hidden"><Logo size={24} compact /></span><span className="hidden sm:inline"><Logo size={24} /></span></Link>
              {me.locations.length > 0 && (
                <div className="ms-auto lg:ms-0 flex min-w-0 items-center gap-2">
                  <Icon name="pin" size={16} className="text-muted hidden sm:block" />
                  {me.locations.length > 1 ? (
                    <select value={locationId ?? ""} onChange={(e) => setLocationId(e.target.value)} aria-label={t("Location")} className="h-9 rounded-lg border border-line-strong bg-surface px-2.5 text-sm font-medium max-w-[34vw] sm:max-w-xs">
                      {me.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  ) : <span className="text-sm font-medium truncate max-w-[34vw] sm:max-w-[50vw]">{me.locations[0].name}</span>}
                </div>
              )}
              <div className="ms-auto flex shrink-0 items-center gap-1">
                {trialDays !== null && <Link href="/app/billing"><Badge tone="gold" className="hidden sm:inline-flex">{trialDays > 0 ? t("Trial: {n} days left", { n: trialDays }) : t("Trial ended")}</Badge></Link>}
                <LangSwitch />
              </div>
            </div>
          </header>
          <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 max-w-[1500px] w-full mx-auto">{children}</main>
        </div>

        <nav className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-charcoal text-white border-t border-white/10 flex justify-around px-1 pb-[env(safe-area-inset-bottom)] no-print" aria-label="Quick navigation">
          {items.filter((n) => n.mobile).slice(0, 5).map((n) => {
            const active = pathname.startsWith(n.href);
            return <Link key={n.href} href={n.href} className={cx("flex flex-col items-center gap-0.5 py-2 px-2 text-[11px] min-w-14", active ? "text-gold" : "text-white/65")}><Icon name={n.icon} size={20} />{t(n.label)}</Link>;
          })}
        </nav>

        <Dialog open={menu} onClose={() => setMenu(false)} title={<Logo />} side size="sm">
          <div className="-mx-2 bg-charcoal rounded-xl p-3 space-y-4">{navList(true)}{user}</div>
        </Dialog>
      </div>
    </Ctx.Provider>
  );
}

export function NoAccess() {
  const { t } = useI18n();
  return <div className="py-20 text-center"><Icon name="lock" size={32} className="mx-auto text-muted" /><h2 className="mt-4 text-xl font-semibold">{t("You don't have access to this page")}</h2><p className="text-muted mt-1 text-sm">{t("Ask an owner or manager to adjust your role.")}</p></div>;
}
