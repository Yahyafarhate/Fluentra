"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useApp, NoAccess } from "@/components/app-shell";
import { Avatar, Badge, Button, Card, Dialog, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, Skeleton, Switch, Textarea, cx } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useFeedback } from "@/components/feedback";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/client";
import { api, ApiError, qs } from "@/lib/client/api";
import { useApi, useDebounced } from "@/lib/client/hooks";

export default function GuestsPage() {
  const { t, fmt } = useI18n();
  const { can, hasFeature } = useApp();
  const router = useRouter();
  const [search, setSearch] = useState(""); const dsearch = useDebounced(search, 300);
  const [f, setF] = useState({ vip: "", minVisits: "", lapsedDays: "", birthdayWithinDays: "", hasAllergies: false, neverVisited: false, sort: "name" });
  const [page, setPage] = useState(0); const [add, setAdd] = useState(false); const [show, setShow] = useState(false);
  const params = useMemo(() => ({ search: dsearch || undefined, vip: f.vip || undefined, minVisits: f.minVisits || undefined, lapsedDays: f.lapsedDays || undefined, birthdayWithinDays: f.birthdayWithinDays || undefined, hasAllergies: f.hasAllergies ? "true" : undefined, neverVisited: f.neverVisited ? "true" : undefined, sort: f.sort, limit: 50, offset: page * 50 }), [dsearch, f, page]);
  const { data, error, loading, reload } = useApi<{ rows: any[]; total: number }>(`/api/v1/customers${qs(params)}`); // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!can("customers.read")) return <NoAccess />;
  const set = (k: keyof typeof f, v: string | boolean) => { setF({ ...f, [k]: v }); setPage(0); };
  return (
    <>
      <PageHeader title={t("Guests")} subtitle={data ? t("{n} guest profiles", { n: data.total }) : undefined}
        actions={<>{can("customers.export") && <a href={`/api/v1/customers/export.csv${qs({ ...params, limit: undefined, offset: undefined })}`}><Button icon="download">{t("Export CSV")}</Button></a>}{can("customers.write") && <Button variant="primary" icon="plus" onClick={() => setAdd(true)}>{t("New guest")}</Button>}</>} />
      <Card className="!p-3 mb-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          <div className="relative flex-1 min-w-52"><Icon name="search" size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted" /><Input className="!ps-9" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} placeholder={t("Search name, phone or email…")} aria-label={t("Search")} /></div>
          <Select value={f.sort} onChange={(e) => set("sort", e.target.value)} className="!w-auto" aria-label={t("Sort")}><option value="name">{t("Name")}</option><option value="recent">{t("Most recent visit")}</option><option value="visits">{t("Most visits")}</option><option value="created">{t("Newest profiles")}</option></Select>
          <Button size="sm" icon="filter" variant={show ? "subtle" : "secondary"} onClick={() => setShow(!show)}>{t("Filters")}</Button>
        </div>
        {show && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 animate-in">
            <Select value={f.vip} onChange={(e) => set("vip", e.target.value)} aria-label="VIP"><option value="">{t("VIP: any")}</option><option value="true">{t("VIP only")}</option><option value="false">{t("Non-VIP")}</option></Select>
            <Input type="number" min={0} placeholder={t("Min. visits")} value={f.minVisits} onChange={(e) => set("minVisits", e.target.value)} />
            <Input type="number" min={1} placeholder={t("Not seen for (days)")} value={f.lapsedDays} onChange={(e) => set("lapsedDays", e.target.value)} />
            <Input type="number" min={0} placeholder={t("Birthday within (days)")} value={f.birthdayWithinDays} onChange={(e) => set("birthdayWithinDays", e.target.value)} />
            <div className="flex flex-col gap-1 justify-center text-sm"><label className="flex items-center gap-2"><input type="checkbox" className="accent-[var(--color-gold)]" checked={f.hasAllergies} onChange={(e) => set("hasAllergies", e.target.checked)} />{t("Has allergies")}</label><label className="flex items-center gap-2"><input type="checkbox" className="accent-[var(--color-gold)]" checked={f.neverVisited} onChange={(e) => set("neverVisited", e.target.checked)} />{t("Never visited")}</label></div>
          </div>
        )}
      </Card>
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>}
      {data && data.rows.length === 0 && <Card><EmptyState icon="users" title={t("No guests found")}>{search || show ? t("Try a different search or clear the filters.") : t("Guest profiles are created automatically from bookings, or add one manually.")}</EmptyState></Card>}
      {data && data.rows.length > 0 && (
        <div className="rounded-xl border border-line bg-surface overflow-hidden">
          <ul className="divide-y divide-line">
            {data.rows.map((c) => (
              <li key={c.id}><Link href={`/app/guests/${c.id}`} className="flex flex-wrap md:flex-nowrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-canvas transition">
                <Avatar name={c.name} vip={c.vip} />
                <div className="min-w-0 flex-1"><p className="font-medium truncate flex items-center gap-1.5">{c.name}{c.vip && <Badge tone="gold">VIP</Badge>}</p><p className="text-xs text-muted truncate">{c.phone ?? "—"} · {c.email ?? "—"}</p></div>
                <div className="hidden md:flex gap-1 flex-wrap w-52">{c.allergies.slice(0, 2).map((a: string) => <Badge key={a} tone="bad">⚠ {a}</Badge>)}{c.tags.slice(0, 2).map((a: string) => <Badge key={a}>{a}</Badge>)}</div>
                <div className="w-20 text-sm text-center"><b className="tabular">{c.visits}</b> <span className="text-muted text-xs">{t("visits")}</span></div>
                <div className="hidden sm:block w-28 text-xs text-muted text-end">{c.lastVisit ? fmt.date(c.lastVisit, { day: "numeric", month: "short", year: "numeric" }) : t("never")}</div>
                <div className="hidden lg:block w-24 text-sm text-end tabular">{c.totalSpend != null ? fmt.money(c.totalSpend) : <span className="text-muted">—</span>}</div>
                <div className="hidden lg:flex gap-1 w-14 text-muted" title={t("Marketing consent")}>{c.consentEmail && <Icon name="mail" size={14} />}{(c.consentSms || c.consentWhatsapp) && <Icon name="message" size={14} />}</div>
              </Link></li>
            ))}
          </ul>
          <div className="flex items-center justify-between px-4 py-3 border-t border-line text-sm bg-canvas/60">
            <span className="text-muted">{page * 50 + 1}–{Math.min(data.total, page * 50 + data.rows.length)} / {data.total}</span>
            <div className="flex gap-2"><Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>{t("Previous")}</Button><Button size="sm" disabled={(page + 1) * 50 >= data.total} onClick={() => setPage(page + 1)}>{t("Next")}</Button></div>
          </div>
        </div>
      )}
      {!hasFeature("crm") && <Notice tone="warn">{t("Your plan does not include the CRM.")}</Notice>}
      <GuestDialog open={add} onClose={() => setAdd(false)} onSaved={(id) => { setAdd(false); router.push(`/app/guests/${id}`); }} />
    </>
  );
}

export function GuestDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (id: string) => void }) {
  const { t } = useI18n(); const { toast } = useFeedback();
  const [f, setF] = useState({ name: "", phone: "", email: "", language: "fr", vip: false, allergies: "", notes: "" }); const [err, setErr] = useState<ApiError | null>(null); const [busy, setBusy] = useState(false);
  const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  async function go() {
    setBusy(true); setErr(null);
    try { const r = await api.post("/api/v1/customers", { name: f.name, phone: f.phone || null, email: f.email || null, language: f.language, vip: f.vip, allergies: split(f.allergies), notes: f.notes || null }); toast.success(t("Guest created")); setF({ name: "", phone: "", email: "", language: "fr", vip: false, allergies: "", notes: "" }); onSaved(r.id); }
    catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  }
  const fe = err?.fields ?? {};
  return (
    <Dialog open={open} onClose={onClose} size="md" title={t("New guest")} footer={<><Button onClick={onClose}>{t("Cancel")}</Button><Button variant="primary" loading={busy} disabled={!f.name.trim()} onClick={go}>{t("Create guest")}</Button></>}>
      <div className="space-y-4 pt-1">
        <Field label={t("Name")} error={fe.name} required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label={t("Phone")} error={fe.phone}><Input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field><Field label={t("Email")} error={fe.email}><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field></div>
        <div className="grid grid-cols-2 gap-3"><Field label={t("Language")}><Select value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}><option value="fr">Français</option><option value="en">English</option><option value="ar">العربية</option></Select></Field><Field label={t("Allergies")} hint={t("Comma-separated")}><Input value={f.allergies} onChange={(e) => setF({ ...f, allergies: e.target.value })} /></Field></div>
        <Field label={t("Notes")}><Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <Switch checked={f.vip} onChange={(v) => setF({ ...f, vip: v })} label="VIP" />
        {err && !Object.keys(fe).length && <Notice tone="bad">{err.message}</Notice>}
        {err?.code === "DUPLICATE_CUSTOMER" && <p className="text-sm"><Link className="underline text-gold-strong" href={`/app/guests/${(err.details as { customerId: string }).customerId}`}>{t("Open the existing profile")}</Link></p>}
      </div>
    </Dialog>
  );
}
void cx;
