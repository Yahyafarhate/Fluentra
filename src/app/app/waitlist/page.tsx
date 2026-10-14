"use client";
import { useEffect, useState } from "react";
import { useApp, NoAccess } from "@/components/app-shell";
import { Badge, Button, Card, Dialog, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, Skeleton, Stat, Switch, Textarea, cx } from "@/components/ui";
import { Icon } from "@/components/icons";
import { WalkInDialog } from "@/components/walkin-dialog";
import { useFeedback } from "@/components/feedback";
import { useI18n } from "@/lib/i18n/client";
import { api, ApiError, qs } from "@/lib/client/api";
import { useApi, useLive } from "@/lib/client/hooks";

const REASONS = [["", "Standard"], ["accessibility", "Accessibility need"], ["reservation_commitment", "Has a reservation commitment"], ["vip", "VIP"], ["other", "Other (note required)"]] as const;

export default function WaitlistPage() {
  const { t } = useI18n();
  const { can, locationId, location: loc } = useApp();
  const { toast, confirm } = useFeedback();
  const { data, error, loading, reload } = useApi<any>(locationId ? `/api/v1/waitlist${qs({ locationId, includeClosed: "true" })}` : null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const pub = useApi<any>(locationId && can("settings.manage") ? `/api/v1/locations/${locationId}` : null); // eslint-disable-line @typescript-eslint/no-explicit-any
  useLive(locationId, reload, 20000);
  const [add, setAdd] = useState(false); const [seat, setSeat] = useState<any>(null); const [busy, setBusy] = useState<string | null>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(i); }, []);

  if (!can("waitlist.manage")) return <NoAccess />;
  async function action(id: string, action: string, ok: string) {
    setBusy(id + action);
    try { await api.post(`/api/v1/waitlist/${id}/action`, { action }); toast.success(ok); reload(); } catch (e) { toast.error(e); } finally { setBusy(null); }
  }
  const entries = data?.entries ?? [];
  const s = data?.stats;
  const slug = loc?.slug;
  return (
    <>
      <PageHeader title={t("Waitlist & walk-ins")} subtitle={t("Guests without a reservation, in priority order.")}
        actions={<>{pub.data?.location?.publicWaitlistEnabled && slug && <Button icon="link" onClick={async () => { await navigator.clipboard?.writeText(`${window.location.origin}/waitlist/${slug}`); toast.success(t("Waitlist link copied")); }}>{t("Copy guest waitlist link")}</Button>}
          <Button variant="primary" icon="plus" onClick={() => setAdd(true)}>{t("Add to waitlist")}</Button></>} />
      <Notice tone="gold" title={t("Estimates, not promises")}>{t("Waiting times are computed from current table availability, the queue ahead and your recent seating durations. They change as the service evolves and are never a guaranteed seating time.")}</Notice>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 my-6">
        <Stat icon="clock" label={t("Waiting now")} value={entries.length} sub={`${entries.filter((e: { status: string }) => e.status === "notified").length} ${t("notified")}`} />
        <Stat icon="users" label={t("Parties ahead (guests)")} value={entries.reduce((n: number, e: { partySize: number }) => n + e.partySize, 0)} />
        <Stat icon="refresh" label={t("Avg wait (30 d)")} value={s?.avgWaitMin != null ? `${s.avgWaitMin} min` : "—"} sub={s ? `${s.seated} ${t("seated")} · ${s.abandoned} ${t("left")}` : undefined} />
        <Stat icon="check" label={t("Seated conversion (30 d)")} value={s?.conversionPct != null ? `${s.conversionPct}%` : "—"} sub={t("of parties that were resolved")} />
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && <div className="space-y-2"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>}
      {data && entries.length === 0 && <Card><EmptyState icon="clock" title={t("Nobody is waiting")} action={<Button variant="primary" icon="plus" onClick={() => setAdd(true)}>{t("Add to waitlist")}</Button>}>{t("When the restaurant is full, add walk-ins here and notify them as tables free up.")}</EmptyState></Card>}
      <ul className="space-y-2.5">
        {entries.map((e: any) => ( // eslint-disable-line @typescript-eslint/no-explicit-any
          <li key={e.id} className={cx("rounded-xl border bg-surface p-4 flex flex-wrap items-center gap-x-5 gap-y-3", e.status === "notified" ? "border-info/50 bg-info-soft/30" : "border-line")}>
            <div className="size-10 rounded-full bg-charcoal text-white grid place-items-center font-semibold shrink-0">{e.position}</div>
            <div className="min-w-0 flex-1">
              <p className="font-semibold flex items-center gap-2 flex-wrap">{e.name}{e.customerVip && <Icon name="crown" size={14} className="text-gold" />}
                {e.priorityReason && <Badge tone="violet">{t(REASONS.find((r) => r[0] === e.priorityReason)?.[1] ?? e.priorityReason)}</Badge>}
                {e.status === "notified" && <Badge tone="info">{t("Notified")}</Badge>}{e.source === "online" && <Badge tone="gold">{t("Online")}</Badge>}</p>
              <p className="text-sm text-muted">{e.partySize} {t("guests")} · {e.phone ?? e.email ?? t("no contact")}{e.seatingPreference ? ` · ${e.seatingPreference}` : ""}{e.notes ? ` · ${e.notes}` : ""}</p>
            </div>
            <div className="text-center w-24"><p className="text-xl font-semibold tabular">{e.waitedMin}<span className="text-xs font-normal text-muted"> min</span></p><p className="text-xs text-muted">{t("waited")}</p></div>
            <div className="text-center w-28"><p className="text-xl font-semibold tabular text-gold-strong">{e.estimatedWaitMin == null ? "?" : e.estimatedWaitMin === 0 ? t("Now") : `~${e.estimatedWaitMin}`}{e.estimatedWaitMin ? <span className="text-xs font-normal text-muted"> min</span> : null}</p><p className="text-xs text-muted">{e.estimatedWaitMin == null ? t("no table fits") : t("estimated")}</p></div>
            <div className="flex flex-wrap gap-2 ms-auto">
              <Button size="sm" variant="gold" icon="utensils" onClick={() => setSeat(e)}>{t("Seat")}</Button>
              {e.status === "waiting" && <Button size="sm" icon="bell" loading={busy === e.id + "notify"} onClick={() => action(e.id, "notify", t("Guest notified that their table is ready"))}>{t("Table ready")}</Button>}
              <Button size="sm" variant="ghost" onClick={async () => { if (await confirm({ title: t("Remove {name}?", { name: e.name }), confirmLabel: t("Remove"), tone: "danger" })) action(e.id, "remove", t("Removed from waitlist")); }}>{t("Remove")}</Button>
              <Button size="sm" variant="ghost" onClick={() => action(e.id, "cancel", t("Marked as cancelled"))}>{t("Left")}</Button>
            </div>
          </li>
        ))}
      </ul>
      {data?.closed?.length > 0 && (
        <details className="mt-8"><summary className="cursor-pointer text-sm font-medium text-ink-2">{t("Resolved in the last 24 hours ({n})", { n: data.closed.length })}</summary>
          <ul className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface text-sm">{data.closed.map((c: any) => <li key={c.id} className="px-4 py-2.5 flex items-center justify-between"><span>{c.name} · {c.partySize}p</span><Badge tone={c.status === "seated" ? "ok" : "neutral"}>{t(c.status)}</Badge></li>)}</ul></details>
      )}
      <AddDialog open={add} onClose={() => setAdd(false)} onDone={() => { setAdd(false); reload(); }} />
      <WalkInDialog open={!!seat} onClose={() => setSeat(null)} onDone={reload} presetParty={seat?.partySize} presetName={seat?.name} waitlistEntryId={seat?.id} />
    </>
  );
}

function AddDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n(); const { locationId } = useApp(); const { toast } = useFeedback();
  const [f, setF] = useState({ name: "", phone: "", email: "", partySize: 2, seatingPreference: "", notes: "", priorityReason: "", sms: false });
  const [est, setEst] = useState<{ minutes: number | null; basis: string } | null>(null); const [err, setErr] = useState<ApiError | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setF({ name: "", phone: "", email: "", partySize: 2, seatingPreference: "", notes: "", priorityReason: "", sms: false }); setErr(null); } }, [open]);
  useEffect(() => { if (!open || !locationId) return; const h = setTimeout(() => api.get(`/api/v1/waitlist/estimate${qs({ locationId, partySize: f.partySize })}`).then(setEst).catch(() => setEst(null)), 250); return () => clearTimeout(h); }, [open, locationId, f.partySize]);
  async function go() {
    setBusy(true); setErr(null);
    try {
      await api.post("/api/v1/waitlist", { locationId, name: f.name, phone: f.phone || null, email: f.email || null, partySize: f.partySize, seatingPreference: f.seatingPreference || null, notes: f.notes || null, priorityReason: f.priorityReason || null, consent: f.sms ? { sms: true, whatsapp: true } : undefined });
      toast.success(t("Added to the waitlist")); onDone();
    } catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  }
  const fe = err?.fields ?? {};
  return (
    <Dialog open={open} onClose={onClose} title={t("Add to waitlist")} size="md" footer={<><Button onClick={onClose}>{t("Cancel")}</Button><Button variant="primary" loading={busy} disabled={!f.name.trim()} onClick={go}>{t("Add to waitlist")}</Button></>}>
      <div className="space-y-4 pt-1">
        <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
          <Field label={t("Name")} error={fe.name} required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
          <Field label={t("Guests")}><div className="flex items-center gap-1.5"><Button aria-label="−" onClick={() => setF({ ...f, partySize: Math.max(1, f.partySize - 1) })}>−</Button><Input type="number" min={1} className="!w-16 text-center" value={f.partySize} onChange={(e) => setF({ ...f, partySize: Math.max(1, Number(e.target.value) || 1) })} /><Button aria-label="+" onClick={() => setF({ ...f, partySize: f.partySize + 1 })}>+</Button></div></Field>
        </div>
        <div className="rounded-xl bg-gold-soft/60 px-4 py-3 text-sm flex items-center gap-3"><Icon name="clock" className="text-gold-strong" />
          <span>{est ? (est.minutes == null ? t("No table can seat this party size.") : <>{t("Estimated wait")}: <b>{est.minutes === 0 ? t("a table is free now") : `~${est.minutes} min`}</b> <span className="text-muted">({est.basis === "historical" ? t("based on your recent seating durations") : t("based on configured durations")} — {t("an estimate, not a guarantee")})</span></>) : "…"}</span></div>
        <div className="grid grid-cols-2 gap-3"><Field label={t("Phone")} error={fe.phone}><Input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field><Field label={t("Email")} error={fe.email}><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field></div>
        <div className="grid grid-cols-2 gap-3"><Field label={t("Seating preference")}><Input value={f.seatingPreference} onChange={(e) => setF({ ...f, seatingPreference: e.target.value })} placeholder={t("Terrace, bar…")} /></Field>
          <Field label={t("Priority")}><Select value={f.priorityReason} onChange={(e) => setF({ ...f, priorityReason: e.target.value })}>{REASONS.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}</Select></Field></div>
        <Field label={t("Notes")}><Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        {f.phone && <Switch checked={f.sms} onChange={(v) => setF({ ...f, sms: v })} label={t("Guest agrees to be messaged (SMS / WhatsApp) when the table is ready")} />}
        {err && !Object.keys(fe).length && <Notice tone="bad">{err.message}</Notice>}
      </div>
    </Dialog>
  );
}
