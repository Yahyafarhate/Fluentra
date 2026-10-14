"use client";
import { useEffect, useState } from "react";
import { useApp, NoAccess } from "@/components/app-shell";
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, Skeleton, Stat, StatusBadge, Switch, Tabs, Textarea } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useFeedback } from "@/components/feedback";
import { useI18n } from "@/lib/i18n/client";
import { api, ApiError } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";

export default function MarketingPage() {
  const { t } = useI18n();
  const { can, hasFeature } = useApp();
  const [tab, setTab] = useState("campaigns");
  if (!can("marketing.manage")) return <NoAccess />;
  if (!hasFeature("marketing")) return <><PageHeader title={t("Marketing")} /><Notice tone="gold" title={t("Marketing is a Pro feature")}>{t("Segments, campaigns, offers and retention metrics are included in the Pro and Enterprise plans.")}</Notice></>;
  return (
    <>
      <PageHeader title={t("Marketing & retention")} subtitle={t("Consent-aware campaigns. Delivery, engagement and bookings are reported separately.")} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "campaigns", label: t("Campaigns") }, { value: "segments", label: t("Segments") }, { value: "offers", label: t("Offers") }, { value: "retention", label: t("Retention") }]} />
      {tab === "campaigns" ? <Campaigns /> : tab === "segments" ? <Segments /> : tab === "offers" ? <Offers /> : <Retention />}
    </>
  );
}

function Campaigns() {
  const { t, fmt } = useI18n(); const { toast, confirm } = useFeedback();
  const { data, error, loading, reload } = useApi<any[]>("/api/v1/marketing/campaigns");  
  const [dlg, setDlg] = useState(false); const [review, setReview] = useState<any>(null); const [results, setResults] = useState<string | null>(null);  
  if (error) return <ErrorState error={error} onRetry={reload} />;
  async function openReview(c: any) { try { setReview({ c, aud: await api.get(`/api/v1/marketing/campaigns/${c.id}/audience`), when: "" }); } catch (e) { toast.error(e); } }  
  async function launch() {
    const { c, aud, when } = review;
    if (!(await confirm({ title: when ? t("Schedule campaign?") : t("Send campaign now?"), message: t("{n} guests with consent will receive “{name}”. {note}", { n: aud.recipients, name: c.name, note: aud.providerStatus.state === "connected" ? "" : aud.providerStatus.message }), confirmLabel: when ? t("Schedule") : t("Send") }))) return;
    try { const r = await api.post(`/api/v1/marketing/campaigns/${c.id}/launch`, { sendAt: when ? new Date(when).toISOString() : null }); toast.success(r.status === "scheduled" ? t("Campaign scheduled") : t("Campaign is being sent")); setReview(null); reload(); } catch (e) { toast.error(e); }
  }
  async function cancel(id: string) { try { await api.post(`/api/v1/marketing/campaigns/${id}/cancel`); toast.success(t("Campaign cancelled")); reload(); } catch (e) { toast.error(e); } }
  return (
    <>
      <div className="flex justify-end mb-4"><Button variant="primary" icon="plus" onClick={() => setDlg(true)}>{t("New campaign")}</Button></div>
      {loading && <Skeleton className="h-48" />}
      {data && data.length === 0 && <Card><EmptyState icon="megaphone" title={t("No campaigns yet")} action={<Button variant="primary" onClick={() => setDlg(true)}>{t("Create your first campaign")}</Button>}>{t("Target a segment with an email, SMS or WhatsApp message. Only guests who consented are included.")}</EmptyState></Card>}
      <ul className="space-y-3">{data?.map((c) => (
        <li key={c.id}><Card className="!p-4 flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="min-w-0 flex-1"><p className="font-semibold flex items-center gap-2">{c.name}<StatusBadge status={c.status} /></p><p className="text-xs text-muted mt-0.5 capitalize">{c.channel} · {c.segmentName ?? t("All guests")}{c.scheduledAt ? ` · ${t("scheduled")} ${fmt.date(c.scheduledAt, { dateStyle: "medium", timeStyle: "short" })}` : ""}{c.sentAt ? ` · ${t("sent")} ${fmt.date(c.sentAt, { dateStyle: "medium" })}` : ""}</p></div>
          {c.recipients > 0 && <span className="text-sm text-ink-2">{c.recipients} {t("recipients")}</span>}
          <div className="flex gap-2">{(c.status === "draft" || c.status === "scheduled") && <Button size="sm" variant="primary" onClick={() => openReview(c)}>{c.status === "draft" ? t("Review & send") : t("Reschedule")}</Button>}{(c.status === "draft" || c.status === "scheduled") && <Button size="sm" variant="ghost" onClick={() => cancel(c.id)}>{t("Cancel")}</Button>}{["sent", "sending"].includes(c.status) && <Button size="sm" onClick={() => setResults(c.id)}>{t("Results")}</Button>}</div>
        </Card></li>))}</ul>
      <CampaignDialog open={dlg} onClose={() => setDlg(false)} onDone={() => { setDlg(false); reload(); }} />
      <Dialog open={!!review} onClose={() => setReview(null)} title={t("Review audience")} size="md" footer={<><Button onClick={() => setReview(null)}>{t("Back")}</Button><Button variant="primary" onClick={launch}>{review?.when ? t("Schedule") : t("Send now")}</Button></>}>
        {review && <div className="space-y-4 pt-1">
          <div className="grid grid-cols-3 gap-3 text-center"><div className="rounded-xl bg-ok-soft p-3"><p className="text-2xl font-semibold text-ok">{review.aud.recipients}</p><p className="text-xs text-muted">{t("will receive it")}</p></div><div className="rounded-xl bg-sunken p-3"><p className="text-2xl font-semibold">{review.aud.segmentSize}</p><p className="text-xs text-muted">{t("in segment")}</p></div><div className="rounded-xl bg-warn-soft p-3"><p className="text-2xl font-semibold text-warn">{review.aud.excluded}</p><p className="text-xs text-muted">{t("excluded (no consent / contact)")}</p></div></div>
          <Notice tone={review.aud.providerStatus.state === "connected" ? "ok" : "gold"} title={review.aud.providerStatus.state === "connected" ? t("Provider connected") : review.aud.providerStatus.state === "simulated" ? t("Simulated delivery") : t("No provider connected")}>{review.aud.providerStatus.message}</Notice>
          <Field label={t("Schedule (optional)")} hint={t("Empty = send immediately")}><Input type="datetime-local" value={review.when} onChange={(e) => setReview({ ...review, when: e.target.value })} /></Field></div>}
      </Dialog>
      <ResultsDialog id={results} onClose={() => setResults(null)} />
    </>
  );
}

function ResultsDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t } = useI18n();
  const { data } = useApi<any>(id ? `/api/v1/marketing/campaigns/${id}/results` : null);  
  return (
    <Dialog open={!!id} onClose={onClose} size="lg" title={data?.campaign.name ?? t("Results")}>
      {!data ? <Skeleton className="h-48" /> : (
        <div className="space-y-5 pt-1">
          <section><h4 className="font-semibold mb-2 flex items-center gap-2"><Icon name="mail" size={16} />{t("1 · Delivery")} <span className="text-xs font-normal text-muted">{t("confirmed by the provider")}</span></h4>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center">{([["recipients", "Recipients"], ["queued", "Queued"], ["sent", "Sent"], ["delivered", "Delivered"], ["failed", "Failed"], ["simulated", "Simulated"]] as const).map(([k, l]) => <div key={k} className="rounded-lg bg-sunken p-2.5"><p className="text-xl font-semibold tabular">{data.delivery[k]}</p><p className="text-[11px] text-muted">{t(l)}</p></div>)}</div>
            {data.delivery.note && <p className="text-xs text-warn mt-2">{data.delivery.note}</p>}</section>
          <section><h4 className="font-semibold mb-2 flex items-center gap-2"><Icon name="eye" size={16} />{t("2 · Engagement")} <span className="text-xs font-normal text-muted">{t("only from provider webhooks")}</span></h4>
            <div className="grid grid-cols-2 gap-2 text-center"><div className="rounded-lg bg-sunken p-2.5"><p className="text-xl font-semibold tabular">{data.engagement.opened}</p><p className="text-[11px] text-muted">{t("Opened")}</p></div><div className="rounded-lg bg-sunken p-2.5"><p className="text-xl font-semibold tabular">{data.engagement.clicked}</p><p className="text-[11px] text-muted">{t("Clicked")}</p></div></div><p className="text-xs text-muted mt-2">{data.engagement.note}</p></section>
          <section><h4 className="font-semibold mb-2 flex items-center gap-2"><Icon name="calendar" size={16} />{t("3 · Bookings")}</h4>
            <div className="grid grid-cols-2 gap-2 text-center"><div className="rounded-lg bg-ok-soft p-2.5"><p className="text-xl font-semibold tabular text-ok">{data.bookings.attributed}</p><p className="text-[11px] text-muted">{t("Attributed (tracked link)")} · {data.bookings.attributedCovers} {t("covers")}</p></div><div className="rounded-lg bg-warn-soft p-2.5"><p className="text-xl font-semibold tabular text-warn">{data.bookings.possiblyInfluenced}</p><p className="text-[11px] text-muted">{t("Possibly influenced (estimate)")}</p></div></div><p className="text-xs text-muted mt-2">{data.bookings.note}</p></section>
        </div>)}
    </Dialog>
  );
}

function CampaignDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n(); const { toast } = useFeedback(); const { me } = useApp();
  const segs = useApi<any[]>(open ? "/api/v1/marketing/segments" : null); const offers = useApi<any[]>(open ? "/api/v1/marketing/offers" : null);  
  const [f, setF] = useState({ name: "", channel: "email", segmentId: "", locationId: "", offerId: "", subject: "", body: "Bonjour {{guest_name}},\n\n{{offer}}\n\nRéservez votre table : {{booking_link}}" }); const [err, setErr] = useState<ApiError | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setErr(null); }, [open]);
  async function go() { setBusy(true); setErr(null); try { await api.post("/api/v1/marketing/campaigns", { ...f, segmentId: f.segmentId || null, locationId: f.locationId || null, offerId: f.offerId || null, subject: f.channel === "email" ? f.subject || null : null }); toast.success(t("Draft created")); onDone(); } catch (e) { setErr(e as ApiError); } finally { setBusy(false); } }
  const fe = err?.fields ?? {};
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={t("New campaign")} footer={<><Button onClick={onClose}>{t("Cancel")}</Button><Button variant="primary" loading={busy} disabled={!f.name || !f.body} onClick={go}>{t("Save draft")}</Button></>}>
      <div className="grid md:grid-cols-2 gap-4 pt-1">
        <Field label={t("Campaign name")} error={fe.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={t("Channel")}><Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}><option value="email">Email</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option></Select></Field>
        <Field label={t("Audience (segment)")}><Select value={f.segmentId} onChange={(e) => setF({ ...f, segmentId: e.target.value })}><option value="">{t("All guests with consent")}</option>{segs.data?.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.reachable[f.channel as "email"]} {t("reachable")})</option>)}</Select></Field>
        <Field label={t("Offer (optional)")}><Select value={f.offerId} onChange={(e) => setF({ ...f, offerId: e.target.value })}><option value="">—</option>{offers.data?.filter((o) => o.active).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
        {me.locations.length > 1 && <Field label={t("Restaurant")}><Select value={f.locationId} onChange={(e) => setF({ ...f, locationId: e.target.value })}><option value="">{t("All locations")}</option>{me.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>}
        {f.channel === "email" && <Field label={t("Subject")} error={fe.subject} className="md:col-span-2"><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>}
        <Field label={t("Message")} error={fe.body} className="md:col-span-2" hint={t("An unsubscribe link is always added.")}><Textarea rows={7} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        <div className="md:col-span-2 flex flex-wrap gap-1.5">{["guest_name", "restaurant", "offer", "booking_link", "unsubscribe_link"].map((v) => <button type="button" key={v} className="text-xs rounded-md bg-sunken hover:bg-line px-2 py-1 font-mono" onClick={() => setF({ ...f, body: f.body + `{{${v}}}` })}>{`{{${v}}}`}</button>)}</div>
        {err && !Object.keys(fe).length && <div className="md:col-span-2"><Notice tone="bad">{err.message}</Notice></div>}
      </div>
    </Dialog>
  );
}

function Segments() {
  const { t } = useI18n(); const { toast, confirm } = useFeedback();
  const { data, error, loading, reload } = useApi<any[]>("/api/v1/marketing/segments");  
  const [dlg, setDlg] = useState(false);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const summary = (c: Record<string, unknown>) => Object.entries(c).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("/") : String(v)}`).join(" · ") || t("everyone");
  return (
    <>
      <div className="flex justify-end mb-4"><Button variant="primary" icon="plus" onClick={() => setDlg(true)}>{t("New segment")}</Button></div>
      {loading && <Skeleton className="h-40" />}
      {data && data.length === 0 && <Card><EmptyState icon="users" title={t("No segments yet")}>{t("Segment guests by visit frequency, recency, VIP status, birthdays and more.")}</EmptyState></Card>}
      <div className="grid md:grid-cols-2 gap-4">{data?.map((s) => (
        <Card key={s.id}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="font-semibold">{s.name}</h3><p className="text-xs text-muted mt-0.5 truncate">{summary(s.criteria)}</p></div><button aria-label={t("Delete")} className="text-muted hover:text-bad" onClick={async () => { if (await confirm({ title: t("Delete segment?"), tone: "danger", confirmLabel: t("Delete") })) { await api.del(`/api/v1/marketing/segments/${s.id}`); toast.success(t("Deleted")); reload(); } }}><Icon name="trash" size={16} /></button></div>
          <div className="mt-4 grid grid-cols-4 gap-2 text-center"><div className="rounded-lg bg-sunken p-2"><p className="text-lg font-semibold">{s.size}</p><p className="text-[11px] text-muted">{t("guests")}</p></div>{(["email", "sms", "whatsapp"] as const).map((c) => <div key={c} className="rounded-lg bg-ok-soft/60 p-2"><p className="text-lg font-semibold text-ok">{s.reachable[c]}</p><p className="text-[11px] text-muted">{c} {t("consent")}</p></div>)}</div></Card>))}</div>
      <SegmentDialog open={dlg} onClose={() => setDlg(false)} onDone={() => { setDlg(false); reload(); }} />
    </>
  );
}

function SegmentDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n(); const { toast } = useFeedback();
  const blank = { name: "", minVisits: "", lapsedDays: "", lastVisitWithinDays: "", birthdayWithinDays: "", minSpend: "", vip: false, hasAllergies: false, neverVisited: false, tags: "" };
  const [f, setF] = useState(blank); const [prev, setPrev] = useState<{ total: number; sample: Array<{ id: string; name: string }> } | null>(null); const [err, setErr] = useState<ApiError | null>(null);
  const criteria = () => {
    const c: Record<string, unknown> = {};
    for (const k of ["minVisits", "lapsedDays", "lastVisitWithinDays", "birthdayWithinDays", "minSpend"] as const) if (f[k] !== "") c[k] = Number(f[k]);
    if (f.vip) c.vip = true; if (f.hasAllergies) c.hasAllergies = true; if (f.neverVisited) c.neverVisited = true;
    const tags = f.tags.split(",").map((x) => x.trim()).filter(Boolean); if (tags.length) c.tags = tags;
    return c;
  };
  useEffect(() => { if (open) { setF(blank); setErr(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!open) return; const h = setTimeout(() => api.post("/api/v1/marketing/segments/preview", criteria()).then(setPrev).catch(() => setPrev(null)), 300); return () => clearTimeout(h); }, [f, open]); // eslint-disable-line react-hooks/exhaustive-deps
  async function go() { try { await api.post("/api/v1/marketing/segments", { name: f.name, criteria: criteria() }); toast.success(t("Segment saved")); onDone(); } catch (e) { setErr(e as ApiError); } }
  const num = (k: keyof typeof f, label: string, hint?: string) => <Field label={label} hint={hint}><Input type="number" min={0} value={f[k] as string} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>;
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={t("New segment")} footer={<><span className="me-auto text-sm text-ink-2"><b className="text-lg">{prev?.total ?? "…"}</b> {t("matching guests")}</span><Button onClick={onClose}>{t("Cancel")}</Button><Button variant="primary" disabled={!f.name.trim()} onClick={go}>{t("Save segment")}</Button></>}>
      <div className="grid sm:grid-cols-2 gap-4 pt-1">
        <Field label={t("Segment name")} className="sm:col-span-2" error={err?.fields.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={t("e.g. Lapsed regulars")} /></Field>
        {num("minVisits", t("At least N visits"))}{num("lapsedDays", t("Not seen for N days"), t("Only guests with a past visit"))}{num("lastVisitWithinDays", t("Visited within N days"))}{num("birthdayWithinDays", t("Birthday within N days"), t("Only guests who shared it"))}{num("minSpend", t("Recorded spend at least"), t("Uses entered spend only"))}
        <Field label={t("Tags")} hint={t("Comma-separated, any match")}><Input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field>
        <div className="sm:col-span-2 flex flex-wrap gap-x-6 gap-y-2"><Switch checked={f.vip} onChange={(v) => setF({ ...f, vip: v })} label="VIP" /><Switch checked={f.hasAllergies} onChange={(v) => setF({ ...f, hasAllergies: v })} label={t("Has allergies")} /><Switch checked={f.neverVisited} onChange={(v) => setF({ ...f, neverVisited: v })} label={t("Never visited")} /></div>
        {prev && prev.sample.length > 0 && <p className="sm:col-span-2 text-xs text-muted">{t("Examples")}: {prev.sample.map((s) => s.name).join(", ")}</p>}
        {err && !err.fields.name && <div className="sm:col-span-2"><Notice tone="bad">{err.message}</Notice></div>}
      </div>
    </Dialog>
  );
}

function Offers() {
  const { t, fmt } = useI18n(); const { toast } = useFeedback();
  const { data, error, loading, reload } = useApi<any[]>("/api/v1/marketing/offers");  
  const [dlg, setDlg] = useState(false); const [f, setF] = useState({ name: "", code: "", description: "", kind: "returning_guest", validTo: "" }); const [err, setErr] = useState<ApiError | null>(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  async function go() { try { await api.post("/api/v1/marketing/offers", { name: f.name, code: f.code || null, description: f.description || null, kind: f.kind, validTo: f.validTo || null }); toast.success(t("Offer created")); setDlg(false); setF({ name: "", code: "", description: "", kind: "returning_guest", validTo: "" }); reload(); } catch (e) { setErr(e as ApiError); } }
  return (
    <>
      <div className="flex justify-end mb-4"><Button variant="primary" icon="plus" onClick={() => { setErr(null); setDlg(true); }}>{t("New offer")}</Button></div>
      {loading && <Skeleton className="h-32" />}
      {data && data.length === 0 && <Card><EmptyState icon="star" title={t("No offers yet")}>{t("Create offers for returning guests, birthdays and special occasions, then attach them to campaigns.")}</EmptyState></Card>}
      <div className="grid md:grid-cols-2 gap-4">{data?.map((o) => <Card key={o.id}><div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{o.name}</h3><p className="text-sm text-ink-2 mt-1">{o.description}</p><div className="flex flex-wrap gap-1.5 mt-3"><Badge tone="gold">{t(o.kind.replace("_", " "))}</Badge>{o.code && <Badge className="font-mono">{o.code}</Badge>}{o.validTo && <Badge>{t("until")} {fmt.date(o.validTo, { day: "numeric", month: "short" })}</Badge>}</div></div><Switch checked={o.active} onChange={async (v) => { await api.post(`/api/v1/marketing/offers/${o.id}/toggle`, { active: v }); reload(); }} /></div></Card>)}</div>
      <Dialog open={dlg} onClose={() => setDlg(false)} size="md" title={t("New offer")} footer={<><Button onClick={() => setDlg(false)}>{t("Cancel")}</Button><Button variant="primary" disabled={!f.name.trim()} onClick={go}>{t("Create")}</Button></>}>
        <div className="space-y-4 pt-1"><Field label={t("Name")} error={err?.fields.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label={t("Description")}><Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <div className="grid grid-cols-3 gap-3"><Field label={t("Type")}><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="returning_guest">{t("Returning guest")}</option><option value="birthday">{t("Birthday")}</option><option value="special_occasion">{t("Special occasion")}</option><option value="event">{t("Event")}</option></Select></Field><Field label={t("Code")}><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field><Field label={t("Valid until")}><Input type="date" value={f.validTo} onChange={(e) => setF({ ...f, validTo: e.target.value })} /></Field></div>
          {err && !err.fields.name && <Notice tone="bad">{err.message}</Notice>}</div>
      </Dialog>
    </>
  );
}

function Retention() {
  const { t } = useI18n();
  const { data, error } = useApi<any>("/api/v1/marketing/retention");  
  if (error) return <ErrorState error={error} />;
  if (!data) return <Skeleton className="h-40" />;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat icon="users" label={t("Active guests (12 months)")} value={data.guests12m} />
        <Stat icon="refresh" label={t("Repeat rate")} value={data.repeatRatePct != null ? `${data.repeatRatePct}%` : "—"} sub={t("{n} guests visited 2+ times", { n: data.repeat })} />
        <Stat icon="clock" label={t("Avg days between visits")} value={data.avgDaysBetween ?? "—"} />
        <Stat icon="alert" label={t("Lapsed (> 90 days)")} value={data.lapsed90} tone={data.lapsed90 ? "bad" : undefined} sub={t("worth a win-back campaign")} />
      </div>
      <Stat icon="sparkle" label={t("New guest profiles (30 days)")} value={data.newGuests30} />
      <p className="text-xs text-muted">{t("Retention is computed from recorded visits only.")}</p>
    </div>
  );
}
