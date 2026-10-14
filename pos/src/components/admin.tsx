"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge, Button, Empty, Input, LangSwitch, Loading, Logo, Select } from "@/components/ui";
import { signOut, useMe } from "@/components/pos-shell";
import { useApi, useLocalState } from "@/lib/client/hooks";
import { daysAgo, dateTime, money, today } from "@/lib/client/format";
import type { Me } from "@/lib/client/types";
import { useT } from "@/lib/i18n";

export interface OutletLite { id: string; name: string; code: string; timezone: string }

export function AdminShell({ children, title }: { children: (me: Me) => ReactNode; title: string }) {
  const t = useT(); const path = usePathname(); const me = useMe("/admin/login");
  if (!me) return <div className="min-h-dvh"><Loading /></div>;
  const has = (p: string) => me.permissions.includes(p);
  const nav = [
    { href: "/admin", label: t("Dashboard"), show: has("reports.view") },
    { href: "/admin/reports", label: t("Reports"), show: has("reports.view") },
    { href: "/admin/end-of-day", label: t("End of day"), show: has("reports.view") },
    { href: "/admin/menu", label: t("Menu"), show: has("menu.manage") },
    { href: "/admin/floor", label: t("Floor"), show: has("floor.manage") },
    { href: "/admin/staff", label: t("Staff"), show: has("staff.manage") },
    { href: "/admin/audit", label: t("Audit"), show: has("audit.view") },
    { href: "/admin/settings", label: t("Settings"), show: has("settings.manage") },
    { href: "/admin/integration", label: t("Fluentra sync"), show: has("settings.manage") },
  ].filter((n) => n.show);
  return (
    <div className="min-h-dvh flex flex-col md:flex-row bg-canvas">
      <aside className="md:w-56 bg-charcoal text-white md:min-h-dvh md:sticky md:top-0 md:self-start no-print">
        <div className="h-14 px-4 flex items-center justify-between md:block md:h-auto md:py-5"><Logo /><div className="md:hidden"><LangSwitch /></div></div>
        <nav className="flex md:block overflow-x-auto px-2 pb-2 md:pb-0 gap-1">{nav.map((n) => <Link key={n.href} href={n.href} className={`block whitespace-nowrap px-3 h-10 leading-10 rounded-lg text-sm ${path === n.href ? "bg-white/15" : "hover:bg-white/10 text-white/80"}`}>{n.label}</Link>)}</nav>
        <div className="hidden md:block p-4 mt-6 text-sm text-white/60 border-t border-white/10"><div className="truncate">{me.employee.name}</div><div className="truncate text-xs">{me.org.name}</div><div className="mt-3 flex gap-2 items-center"><LangSwitch /><button onClick={() => signOut("/admin/login")} className="text-white/70 underline">{t("Sign out")}</button></div></div>
      </aside>
      <main className="flex-1 min-w-0 p-4 md:p-8 max-w-6xl">
        <h1 className="text-3xl font-semibold mb-5">{title}</h1>
        {children(me)}
      </main>
    </div>
  );
}

/** Outlet selector that remembers its choice. */
export function useOutlet() {
  const { data } = useApi<OutletLite[]>("/outlets");
  const [saved, setSaved] = useLocalState<string>("cp_admin_outlet", "");
  const outlet = data?.find((o) => o.id === saved) ?? data?.[0] ?? null;
  return { outlets: data ?? [], outlet, setOutletId: setSaved };
}
export function OutletPicker({ outlets, value, onChange, all }: { outlets: OutletLite[]; value: string; onChange: (id: string) => void; all?: boolean }) {
  const t = useT();
  if (outlets.length <= 1 && !all) return outlets[0] ? <Badge tone="gold">{outlets[0].name}</Badge> : null;
  return <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-52" aria-label={t("Outlet")}>{all && <option value="">{t("All outlets")}</option>}{outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>;
}

export function RangePicker({ from, to, onChange }: { from: string; to: string; onChange: (f: string, t: string) => void }) {
  const t = useT();
  const presets: Array<[string, string, string]> = [[t("Today"), today(), today()], [t("Yesterday"), daysAgo(1), daysAgo(1)], [t("7 days"), daysAgo(6), today()], [t("30 days"), daysAgo(29), today()]];
  return (
    <div className="flex flex-wrap gap-2 items-center">
      {presets.map(([l, f, to2]) => <Button key={l} size="sm" variant={from === f && to === to2 ? "primary" : "secondary"} onClick={() => onChange(f, to2)}>{l}</Button>)}
      <Input type="date" value={from} max={to} onChange={(e) => e.target.value && onChange(e.target.value, to)} className="w-40 h-9" aria-label={t("From")} />
      <Input type="date" value={to} min={from} onChange={(e) => e.target.value && onChange(from, e.target.value)} className="w-40 h-9" aria-label={t("To")} />
    </div>
  );
}

/** Generic table: keys ending in `Cents` are shown as money, `At` as date-time. */
export function DataTable({ rows, currency = "MAD", columns, onRow, empty }: { rows: Array<Record<string, unknown>> | null | undefined; currency?: string; columns?: string[]; onRow?: (r: Record<string, unknown>) => void; empty?: string }) {
  const t = useT();
  const cols = useMemo(() => columns ?? (rows?.[0] ? Object.keys(rows[0]).filter((k) => !/^(id|orderId|employeeId|productId|payload|metadata)$/i.test(k) && typeof rows[0][k] !== "object" || k === "metadata") : []), [rows, columns]);
  if (!rows || rows.length === 0) return <Empty title={empty ?? t("No data for this period")} />;
  const cell = (k: string, v: unknown) => {
    if (v === null || v === undefined) return "—";
    if (typeof v === "number" && /cents$/i.test(k)) return <span className="tabular">{money(v, currency)}</span>;
    if (/At$|^at$/.test(k) && typeof v === "string") return dateTime(v);
    if (typeof v === "boolean") return v ? "✓" : "—";
    if (typeof v === "object") return <code className="text-xs">{JSON.stringify(v).slice(0, 120)}</code>;
    return String(v);
  };
  const label = (k: string) => t(k.replace(/Cents$/, "").replace(/([A-Z])/g, " $1").toLowerCase().replace(/^./, (c) => c.toUpperCase()));
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
      <table className="w-full text-sm">
        <thead><tr className="text-start text-ink-2 border-b border-line">{cols.map((k) => <th key={k} className="text-start font-medium px-3 py-2 whitespace-nowrap">{label(k)}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} onClick={onRow ? () => onRow(r) : undefined} className={`border-b border-line last:border-0 ${onRow ? "cursor-pointer hover:bg-canvas" : ""}`}>{cols.map((k) => <td key={k} className="px-3 py-2 whitespace-nowrap">{cell(k, r[k])}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: ReactNode; tone?: "ok" | "bad" }) {
  return <div className="rounded-2xl border border-line bg-surface p-4 shadow-card"><div className="text-sm text-ink-2">{label}</div><div className={`text-2xl font-semibold mt-1 tabular ${tone === "bad" ? "text-bad" : ""}`}>{value}</div>{sub && <div className="text-xs text-muted mt-1">{sub}</div>}</div>;
}

export function Bars({ data, format }: { data: Array<{ label: string; value: number }>; format: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex items-end gap-1 h-40" role="img" aria-label="bar chart">
      {data.map((d) => <div key={d.label} className="flex-1 min-w-0 flex flex-col items-center justify-end h-full group" title={`${d.label}: ${format(d.value)}`}><div className="w-full rounded-t-md bg-gold/80 group-hover:bg-gold-strong" style={{ height: `${Math.max(2, (d.value / max) * 100)}%` }} /><div className="text-[10px] text-muted mt-1 truncate w-full text-center">{d.label}</div></div>)}
    </div>
  );
}

export const useRange = (days = 7) => { const [r, setR] = useState({ from: daysAgo(days - 1), to: today() }); useEffect(() => undefined, []); return [r, (f: string, t: string) => setR({ from: f, to: t })] as const; };
