"use client";
import { useEffect, useState } from "react";
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Notice, Skeleton, Switch, cx } from "@/components/ui";
import { useFeedback } from "@/components/feedback";
import { useI18n } from "@/lib/i18n/client";
import { api, ApiError } from "@/lib/client/api";
import { useLocationSettings } from "./use-location";

const ISO = [1, 2, 3, 4, 5, 6, 7];

export function HoursTab() {
  const { t, fmt } = useI18n();
  const { toast, confirm } = useFeedback();
  const s = useLocationSettings();
  const [svc, setSvc] = useState<any | null | "new">(null); const [sd, setSd] = useState(false);  
  const dayName = (d: number) => fmt.date(new Date(Date.UTC(2024, 0, d)).toISOString().slice(0, 10), { weekday: "short" });
  if (!s.loc) return <Skeleton className="h-64" />;
  async function del(kind: "services" | "special-days", id: string, label: string) {
    if (!(await confirm({ title: t("Delete {name}?", { name: label }), tone: "danger", confirmLabel: t("Delete") }))) return;
    try { await api.del(`/api/v1/${kind}/${id}`); toast.success(t("Deleted")); s.reload(); } catch (e) { toast.error(e); }
  }
  return (
    <div className="grid lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader title={t("Service periods")} subtitle={t("Each service defines the days and hours guests can be seated. No overlaps on shared days.")} action={<Button size="sm" variant="primary" icon="plus" onClick={() => setSvc("new")}>{t("Add service")}</Button>} />
        {s.services.length === 0 ? <EmptyState icon="clock" title={t("No services")}>{t("Add a service (e.g. Lunch, Dinner) to open your booking page.")}</EmptyState> : (
          <ul className="space-y-3">{s.services.map((x: any) => (  
            <li key={x.id} className={cx("rounded-xl border p-3.5", x.active ? "border-line" : "border-line bg-sunken opacity-70")}>
              <div className="flex items-center gap-2"><b>{x.name}</b>{!x.active && <Badge>{t("Inactive")}</Badge>}<span className="ms-auto tabular text-sm">{x.startTime} → {x.lastSeating} <span className="text-muted">({t("last seating")})</span></span></div>
              <div className="mt-2 flex flex-wrap gap-1">{ISO.map((d) => <span key={d} className={cx("text-xs rounded-md px-1.5 py-0.5", x.days.includes(d) ? "bg-charcoal text-white" : "bg-sunken text-muted/60")}>{dayName(d)}</span>)}</div>
              <div className="mt-2 flex items-center gap-3 text-xs text-muted">{x.slotIntervalMin && <span>{x.slotIntervalMin} min {t("slots")}</span>}{x.maxCovers && <span>{t("max {n} covers", { n: x.maxCovers })}</span>}
                <span className="ms-auto flex gap-2"><button className="text-gold-strong hover:underline" onClick={() => setSvc(x)}>{t("Edit")}</button><button className="text-bad hover:underline" onClick={() => del("services", x.id, x.name)}>{t("Delete")}</button></span></div>
            </li>))}</ul>
        )}
      </Card>
      <Card>
        <CardHeader title={t("Holidays & special days")} subtitle={t("Close the restaurant or set special hours for a date.")} action={<Button size="sm" variant="primary" icon="plus" onClick={() => setSd(true)}>{t("Add date")}</Button>} />
        {s.specialDays.length === 0 ? <p className="text-sm text-muted py-4">{t("No upcoming special days.")}</p> : (
          <ul className="divide-y divide-line">{s.specialDays.map((d: any) => (  
            <li key={d.id} className="py-2.5 flex items-center gap-3"><span className="tabular text-sm w-32">{fmt.date(d.date, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</span>{d.closed ? <Badge tone="bad">{t("Closed")}</Badge> : <Badge tone="gold">{d.startTime}–{d.lastSeating}</Badge>}<span className="text-sm text-ink-2 truncate flex-1">{d.label}</span><button className="text-bad text-sm hover:underline" onClick={() => del("special-days", d.id, d.date)}>{t("Remove")}</button></li>))}</ul>)}
      </Card>
      <ServiceDialog open={!!svc} service={svc === "new" ? null : svc} locationId={s.locationId!} dayName={dayName} onClose={() => setSvc(null)} onDone={() => { setSvc(null); s.reload(); }} />
      <SpecialDialog open={sd} locationId={s.locationId!} onClose={() => setSd(false)} onDone={() => { setSd(false); s.reload(); }} />
    </div>
  );
}

function ServiceDialog({ open, service, locationId, dayName, onClose, onDone }: { open: boolean; service: any | null; locationId: string; dayName: (d: number) => string; onClose: () => void; onDone: () => void }) {  
  const { t } = useI18n(); const { toast } = useFeedback();
  const [f, setF] = useState({ name: "", days: [1, 2, 3, 4, 5, 6, 7] as number[], startTime: "12:00", lastSeating: "14:30", slotIntervalMin: "", maxCovers: "", active: true }); const [err, setErr] = useState<ApiError | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) return; setErr(null); setF(service ? { name: service.name, days: service.days, startTime: service.startTime, lastSeating: service.lastSeating, slotIntervalMin: service.slotIntervalMin?.toString() ?? "", maxCovers: service.maxCovers?.toString() ?? "", active: service.active } : { name: "", days: [1, 2, 3, 4, 5, 6, 7], startTime: "12:00", lastSeating: "14:30", slotIntervalMin: "", maxCovers: "", active: true }); }, [open, service]);
  async function go() {
    setBusy(true); setErr(null);
    const body = { locationId, name: f.name, days: f.days, startTime: f.startTime, lastSeating: f.lastSeating, slotIntervalMin: f.slotIntervalMin ? Number(f.slotIntervalMin) : null, maxCovers: f.maxCovers ? Number(f.maxCovers) : null, active: f.active };
    try { if (service) await api.put(`/api/v1/services/${service.id}`, body); else await api.post("/api/v1/services", body); toast.success(t("Service saved")); onDone(); } catch (e) { setErr(e as ApiError); } finally { setBusy(false); }
  }
  const fe = err?.fields ?? {};
  return (
    <Dialog open={open} onClose={onClose} size="md" title={service ? t("Edit service") : t("New service")} footer={<><Button onClick={onClose}>{t("Cancel")}</Button><Button variant="primary" loading={busy} disabled={!f.name.trim() || !f.days.length} onClick={go}>{t("Save")}</Button></>}>
      <div className="space-y-4 pt-1">
        <Field label={t("Name")} error={fe.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={t("Lunch, Dinner, Brunch…")} /></Field>
        <div><p className="text-[13px] font-medium text-ink-2 mb-1.5">{t("Days")}</p><div className="flex flex-wrap gap-1.5">{ISO.map((d) => <button type="button" key={d} aria-pressed={f.days.includes(d)} onClick={() => setF({ ...f, days: f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d].sort() })} className={cx("h-9 px-3 rounded-lg text-sm border", f.days.includes(d) ? "bg-charcoal text-white border-charcoal" : "bg-surface border-line-strong")}>{dayName(d)}</button>)}</div></div>
        <div className="grid grid-cols-2 gap-3"><Field label={t("Opens")} error={fe.startTime}><Input type="time" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} /></Field><Field label={t("Last seating")} error={fe.lastSeating}><Input type="time" value={f.lastSeating} onChange={(e) => setF({ ...f, lastSeating: e.target.value })} /></Field></div>
        <div className="grid grid-cols-2 gap-3"><Field label={t("Slot interval (min)")} hint={t("Empty = restaurant default")}><Input type="number" min={5} max={120} step={5} value={f.slotIntervalMin} onChange={(e) => setF({ ...f, slotIntervalMin: e.target.value })} /></Field><Field label={t("Max covers for this service")} hint={t("Empty = no limit")}><Input type="number" min={1} value={f.maxCovers} onChange={(e) => setF({ ...f, maxCovers: e.target.value })} /></Field></div>
        <Switch checked={f.active} onChange={(v) => setF({ ...f, active: v })} label={t("Active")} />
        {err && !Object.keys(fe).length && <Notice tone="bad">{err.message}</Notice>}
      </div>
    </Dialog>
  );
}

function SpecialDialog({ open, locationId, onClose, onDone }: { open: boolean; locationId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n(); const { toast } = useFeedback();
  const [f, setF] = useState({ date: "", closed: true, label: "", startTime: "19:00", lastSeating: "21:30" }); const [err, setErr] = useState<ApiError | null>(null);
  useEffect(() => { if (open) { setF({ date: "", closed: true, label: "", startTime: "19:00", lastSeating: "21:30" }); setErr(null); } }, [open]);
  async function go() {
    try { const r = await api.post("/api/v1/special-days", { locationId, date: f.date, closed: f.closed, label: f.label || null, startTime: f.closed ? null : f.startTime, lastSeating: f.closed ? null : f.lastSeating }); toast.success(r.affectedReservations ? t("Saved — {n} existing reservations on that day need attention", { n: r.affectedReservations }) : t("Saved")); onDone(); } catch (e) { setErr(e as ApiError); }
  }
  const fe = err?.fields ?? {};
  return (
    <Dialog open={open} onClose={onClose} size="sm" title={t("Special day")} footer={<><Button onClick={onClose}>{t("Cancel")}</Button><Button variant="primary" disabled={!f.date} onClick={go}>{t("Save")}</Button></>}>
      <div className="space-y-4 pt-1"><Field label={t("Date")} error={fe.date}><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label={t("Label")}><Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder={t("Eid, private event, gala…")} /></Field>
        <Switch checked={f.closed} onChange={(v) => setF({ ...f, closed: v })} label={t("Closed all day")} />
        {!f.closed && <div className="grid grid-cols-2 gap-3"><Field label={t("Opens")} error={fe.startTime}><Input type="time" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} /></Field><Field label={t("Last seating")}><Input type="time" value={f.lastSeating} onChange={(e) => setF({ ...f, lastSeating: e.target.value })} /></Field></div>}
        {f.closed && <Notice tone="warn">{t("Existing reservations are not cancelled automatically — review them in the Reservations page.")}</Notice>}
        {err && !Object.keys(fe).length && <Notice tone="bad">{err.message}</Notice>}</div>
    </Dialog>
  );
}
