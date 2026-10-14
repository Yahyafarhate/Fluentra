"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useApp, NoAccess } from "@/components/app-shell";
import { Avatar, Badge, Button, Card, CardHeader, Dialog, EmptyState, ErrorState, Field, Input, Notice, Select, Skeleton, StatusBadge, Stat, Switch, Textarea, Tabs } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useFeedback } from "@/components/feedback";
import { useI18n } from "@/lib/i18n/client";
import { api, ApiError, qs } from "@/lib/client/api";
import { useApi, useDebounced } from "@/lib/client/hooks";

const csv = (a: string[]) => a.join(", ");
const split = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export default function GuestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, fmt } = useI18n();
  const { can, me } = useApp();
  const { toast, confirm } = useFeedback();
  const router = useRouter();
  const { data, error, loading, reload } = useApi<any>(`/api/v1/customers/${id}`);  
  const [tab, setTab] = useState<"profile" | "history" | "privacy">("profile");
  const [f, setF] = useState<any>(null); const [err, setErr] = useState<ApiError | null>(null); const [busy, setBusy] = useState(false);  
  const [merge, setMerge] = useState(false);

  useEffect(() => {
    const c = data?.customer; if (!c) return;
    setF({ name: c.name, phone: c.phone ?? "", email: c.email ?? "", language: c.language ?? "fr", vip: c.vip, tags: csv(c.tags), dietary: csv(c.dietary), allergies: csv(c.allergies), seatingPreferences: c.seatingPreferences ?? "", birthday: c.birthday ?? "", anniversary: c.anniversary ?? "", notes: c.notes ?? "", preferredLocationId: c.preferredLocationId ?? "" });
  }, [data]);
  if (!can("customers.read")) return <NoAccess />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !f) return <div className="space-y-4"><Skeleton className="h-24" /><Skeleton className="h-96" /></div>;
  const c = data.customer; const s = data.stats; const writable = can("customers.write");
  const fe = err?.fields ?? {};

  async function save() {
    setBusy(true); setErr(null);
    try {
      await api.patch(`/api/v1/customers/${id}`, { name: f.name, phone: f.phone || null, email: f.email || null, language: f.language, vip: f.vip, tags: split(f.tags), dietary: split(f.dietary), allergies: split(f.allergies), seatingPreferences: f.seatingPreferences || null, birthday: f.birthday || null, anniversary: f.anniversary || null, notes: f.notes || null, preferredLocationId: f.preferredLocationId || null });
      toast.success(t("Profile saved")); reload();
    } catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  }
  async function consent(channel: string, granted: boolean) {
    try { await api.post(`/api/v1/customers/${id}/consent`, { channel, granted }); toast.success(granted ? t("Consent recorded") : t("Consent withdrawn")); reload(); } catch (e) { toast.error(e); }
  }
  async function erase() {
    if (!(await confirm({ title: t("Erase personal data?"), message: t("This irreversibly anonymizes the guest: name, contact details, notes and message content are removed. Anonymous visit statistics are kept."), tone: "danger", requireText: "ERASE", confirmLabel: t("Erase permanently") }))) return;
    try { await api.post(`/api/v1/customers/${id}/erase`, { confirm: true }); toast.success(t("Guest data erased")); router.push("/app/guests"); } catch (e) { toast.error(e); }
  }

  return (
    <>
      <Link href="/app/guests" className="text-sm text-muted hover:text-ink inline-flex items-center gap-1 mb-3"><Icon name="chevronLeft" size={14} className="rtl:rotate-180" />{t("All guests")}</Link>
      <div className="flex flex-wrap items-center gap-4 mb-6">
        <Avatar name={c.name} vip={c.vip} size={60} />
        <div className="min-w-0 flex-1">
          <h1 className="text-3xl font-semibold flex items-center gap-2 flex-wrap">{c.name}{c.vip && <Badge tone="gold"><Icon name="crown" size={12} />VIP</Badge>}</h1>
          <p className="text-muted text-sm mt-1 flex flex-wrap gap-x-4 gap-y-1">{c.phone && <span className="inline-flex items-center gap-1.5"><Icon name="phone" size={14} />{c.phone}</span>}{c.email && <span className="inline-flex items-center gap-1.5"><Icon name="mail" size={14} />{c.email}</span>}<span>{t("Guest since {date}", { date: fmt.date(c.createdAt, { month: "long", year: "numeric" }) })}</span></p>
        </div>
        {can("reservations.write") && <Link href={`/app/reservations?q=${encodeURIComponent(c.name)}`}><Button icon="calendar">{t("Reservations")}</Button></Link>}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
        <Stat label={t("Visits")} value={s.visits} icon="utensils" />
        <Stat label={t("Last visit")} value={s.lastVisit ? fmt.date(s.lastVisit, { day: "numeric", month: "short" }) : "—"} icon="calendar" />
        <Stat label={t("Spend (recorded)")} value={s.totalSpend != null ? fmt.money(s.totalSpend) : "—"} sub={s.spendRecorded ? t("{n} of {v} visits", { n: s.spendRecorded, v: s.visits }) : t("none recorded")} icon="card" />
        <Stat label={t("No-shows")} value={s.noShows} tone={s.noShows ? "bad" : undefined} icon="ban" />
        <Stat label={t("Upcoming")} value={s.upcoming} icon="clock" />
      </div>
      {(c.allergies?.length > 0 || c.dietary?.length > 0) && <div className="mb-6"><Notice tone="bad" title={t("Dietary & allergy information")}>{[...c.allergies.map((a: string) => `⚠ ${a}`), ...c.dietary].join(" · ")}</Notice></div>}

      <Tabs value={tab} onChange={setTab} tabs={[{ value: "profile", label: t("Profile") }, { value: "history", label: t("History & feedback") }, { value: "privacy", label: t("Consent & privacy") }]} />

      {tab === "profile" && (
        <Card>
          <div className="grid md:grid-cols-2 gap-x-8 gap-y-4">
            <Field label={t("Name")} error={fe.name}><Input value={f.name} disabled={!writable} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label={t("Language")}><Select disabled={!writable} value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}><option value="fr">Français</option><option value="en">English</option><option value="ar">العربية</option></Select></Field>
            <Field label={t("Phone")} error={fe.phone}><Input type="tel" disabled={!writable} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
            <Field label={t("Email")} error={fe.email}><Input type="email" disabled={!writable} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label={t("Allergies")} hint={t("Comma-separated. Shown on every reservation.")}><Input disabled={!writable} value={f.allergies} onChange={(e) => setF({ ...f, allergies: e.target.value })} /></Field>
            <Field label={t("Dietary preferences")} hint={t("Comma-separated")}><Input disabled={!writable} value={f.dietary} onChange={(e) => setF({ ...f, dietary: e.target.value })} /></Field>
            <Field label={t("Tags")} hint={t("Comma-separated")}><Input disabled={!writable} value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field>
            <Field label={t("Seating preferences")}><Input disabled={!writable} value={f.seatingPreferences} onChange={(e) => setF({ ...f, seatingPreferences: e.target.value })} /></Field>
            <Field label={t("Birthday")} hint={t("Only if the guest chose to share it.")}><Input type="date" disabled={!writable} value={f.birthday} onChange={(e) => setF({ ...f, birthday: e.target.value })} /></Field>
            <Field label={t("Anniversary")}><Input type="date" disabled={!writable} value={f.anniversary} onChange={(e) => setF({ ...f, anniversary: e.target.value })} /></Field>
            <Field label={t("Preferred location")}><Select disabled={!writable} value={f.preferredLocationId} onChange={(e) => setF({ ...f, preferredLocationId: e.target.value })}><option value="">—</option>{me.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
            <div className="flex items-end pb-1"><Switch checked={f.vip} disabled={!writable} onChange={(v) => setF({ ...f, vip: v })} label={<span className="inline-flex items-center gap-1.5"><Icon name="crown" size={15} className="text-gold" />{t("VIP guest")}</span>} /></div>
            <Field label={t("Service notes")} className="md:col-span-2"><Textarea rows={3} disabled={!writable} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          </div>
          {err && !Object.keys(fe).length && <div className="mt-4"><Notice tone="bad">{err.message}</Notice></div>}
          {writable && <div className="mt-5 flex gap-2 flex-wrap"><Button variant="primary" loading={busy} onClick={save}>{t("Save profile")}</Button>{can("customers.merge") && <Button icon="users" className="ms-auto" onClick={() => setMerge(true)}>{t("Merge duplicate…")}</Button>}</div>}
        </Card>
      )}

      {tab === "history" && (
        <div className="grid lg:grid-cols-[1.4fr_1fr] gap-6">
          <Card pad={false}>
            <div className="p-5 pb-2"><CardHeader title={t("Reservation history")} subtitle={s.cancellations ? t("{n} cancelled", { n: s.cancellations }) : undefined} /></div>
            {data.reservations.length === 0 ? <EmptyState icon="calendar" title={t("No reservations yet")} /> : (
              <ul className="divide-y divide-line">{data.reservations.map((r: any) => (  
                <li key={r.id} className="px-5 py-3 flex items-center gap-3 flex-wrap"><span className="tabular text-sm w-28">{fmt.date(r.startAt, { day: "numeric", month: "short", year: "numeric" })}</span><span className="text-sm flex-1 min-w-0 truncate">{r.locationName} · {r.partySize}p{r.occasion ? ` · ${r.occasion}` : ""}</span><StatusBadge status={r.status} /></li>))}</ul>)}
          </Card>
          <div className="space-y-6">
            <Card><CardHeader title={t("Visits by location")} />{data.visitsByLocation.length ? <ul className="space-y-1.5 text-sm">{data.visitsByLocation.map((v: { name: string; visits: number }) => <li key={v.name} className="flex justify-between"><span>{v.name}</span><b>{v.visits}</b></li>)}</ul> : <p className="text-sm text-muted">{t("No visits yet.")}</p>}</Card>
            <Card><CardHeader title={t("Feedback")} />{data.feedback.length ? <ul className="space-y-3">{data.feedback.map((x: { id: string; rating: number; comment: string | null; submittedAt: string }) => <li key={x.id} className="text-sm"><div className="flex items-center gap-2"><span className="text-gold" aria-label={`${x.rating}/5`}>{"★".repeat(x.rating)}<span className="text-line-strong">{"★".repeat(5 - x.rating)}</span></span><span className="text-xs text-muted">{fmt.date(x.submittedAt, { day: "numeric", month: "short" })}</span></div>{x.comment && <p className="text-ink-2 mt-0.5">{x.comment}</p>}</li>)}</ul> : <p className="text-sm text-muted">{t("No feedback received.")}</p>}</Card>
          </div>
        </div>
      )}

      {tab === "privacy" && (
        <div className="grid lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader title={t("Marketing consent")} subtitle={t("Transactional messages (confirmations, reminders) don't need it. Campaigns, birthday greetings and feedback requests do.")} />
            <div className="space-y-3">
              {([["email", "consentEmail"], ["sms", "consentSms"], ["whatsapp", "consentWhatsapp"]] as const).map(([ch, key]) => (
                <div key={ch} className="flex items-center justify-between rounded-lg border border-line px-3 py-2.5"><span className="text-sm capitalize flex items-center gap-2"><Icon name={ch === "email" ? "mail" : "message"} size={16} />{ch === "sms" ? "SMS" : ch === "whatsapp" ? "WhatsApp" : "Email"}</span>
                  <Switch checked={!!c[key]} disabled={!writable} onChange={(v) => consent(ch, v)} /></div>))}
            </div>
            <h4 className="text-sm font-semibold mt-5 mb-2">{t("Consent ledger")}</h4>
            {data.consents.length === 0 ? <p className="text-sm text-muted">{t("No consent events recorded.")}</p> : <ul className="text-xs space-y-1 max-h-48 overflow-y-auto scroll-thin">{data.consents.map((x: { channel: string; granted: boolean; source: string; createdAt: string }, i: number) => <li key={i} className="flex justify-between gap-3"><span>{x.granted ? "✓ granted" : "✕ withdrawn"} · {x.channel}</span><span className="text-muted">{x.source.replace("_", " ")} · {fmt.date(x.createdAt, { dateStyle: "medium" })}</span></li>)}</ul>}
          </Card>
          <Card>
            <CardHeader title={t("Data rights")} subtitle={t("Access and erasure requests (Moroccan law 09-08 / GDPR style).")} />
            <div className="space-y-3">
              {can("customers.privacy") ? <>
                <div className="rounded-lg border border-line p-4"><p className="font-medium text-sm">{t("Export all personal data")}</p><p className="text-xs text-muted mt-0.5 mb-3">{t("Downloads a JSON file with the profile, reservations, visits, consents and messages. The export is recorded in the audit log.")}</p><a href={`/api/v1/customers/${id}/data-export`}><Button icon="download">{t("Download export")}</Button></a></div>
                <div className="rounded-lg border border-bad/30 bg-bad-soft/30 p-4"><p className="font-medium text-sm text-bad">{t("Erase personal data")}</p><p className="text-xs text-ink-2 mt-0.5 mb-3">{t("Right to erasure. Irreversible. Visit counts remain as anonymous statistics.")}</p><Button variant="danger" icon="trash" onClick={erase}>{t("Erase guest…")}</Button></div>
              </> : <Notice tone="info">{t("Only owners and general managers can export or erase guest data.")}</Notice>}
              <p className="text-xs text-muted">{t("Inactive guests are anonymized automatically after the retention period set in Settings → Data & privacy.")}</p>
            </div>
          </Card>
        </div>
      )}

      <MergeDialog open={merge} onClose={() => setMerge(false)} sourceId={id} sourceName={c.name} onDone={(target) => { setMerge(false); router.push(`/app/guests/${target}`); }} />
    </>
  );
}

function MergeDialog({ open, onClose, sourceId, sourceName, onDone }: { open: boolean; onClose: () => void; sourceId: string; sourceName: string; onDone: (targetId: string) => void }) {
  const { t } = useI18n(); const { toast, confirm } = useFeedback();
  const [q, setQ] = useState(""); const dq = useDebounced(q, 250);
  const { data } = useApi<{ rows: Array<{ id: string; name: string; phone: string | null; email: string | null; visits: number }> }>(open && dq.length >= 2 ? `/api/v1/customers${qs({ search: dq, limit: 8 })}` : null);
  useEffect(() => { if (open) setQ(""); }, [open]);
  async function go(target: { id: string; name: string }) {
    if (!(await confirm({ title: t("Merge profiles?"), message: t("“{a}” will be merged INTO “{b}”. Reservations, visits, messages and notes move to “{b}”. This is recorded in the audit log.", { a: sourceName, b: target.name }), confirmLabel: t("Merge") }))) return;
    try { await api.post("/api/v1/customers/merge", { sourceId, targetId: target.id }); toast.success(t("Profiles merged")); onDone(target.id); } catch (e) { toast.error(e); }
  }
  return (
    <Dialog open={open} onClose={onClose} size="md" title={t("Merge duplicate profile")} description={t("Find the profile to keep. Names alone never trigger an automatic merge.")}>
      <div className="space-y-3 pt-1"><Input placeholder={t("Search the profile to keep…")} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <ul className="divide-y divide-line rounded-xl border border-line">{(data?.rows ?? []).filter((r) => r.id !== sourceId).map((r) => <li key={r.id} className="flex items-center gap-3 px-3 py-2.5"><div className="min-w-0 flex-1"><p className="text-sm font-medium truncate">{r.name}</p><p className="text-xs text-muted truncate">{r.phone ?? "—"} · {r.email ?? "—"} · {r.visits} {t("visits")}</p></div><Button size="sm" onClick={() => go(r)}>{t("Keep this one")}</Button></li>)}
          {q.length >= 2 && data && data.rows.filter((r) => r.id !== sourceId).length === 0 && <li className="px-3 py-4 text-sm text-muted text-center">{t("No other profile matches.")}</li>}</ul></div>
    </Dialog>
  );
}
