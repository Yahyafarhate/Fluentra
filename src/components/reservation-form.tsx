"use client";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Dialog, Field, Input, Notice, Select, Spinner, Switch, Textarea, cx } from "./ui";
import { Icon } from "./icons";
import { useApp } from "./app-shell";
import { useFeedback } from "./feedback";
import { useI18n } from "@/lib/i18n/client";
import { api, ApiError, qs } from "@/lib/client/api";
import { OCCASIONS, SOURCES, SOURCE_LABEL } from "@/lib/client/format";
import { useDebounced } from "@/lib/client/hooks";

interface Slot { time: string; available: boolean; reason?: string; serviceName: string; tables?: string[]; durationMin: number }
interface Initial {
  id?: string; date?: string; time?: string; partySize?: number; guestName?: string; guestPhone?: string | null; guestEmail?: string | null; source?: string; occasion?: string | null;
  specialRequests?: string | null; internalNotes?: string | null; seatingPreference?: string | null; isVip?: boolean; isPrivateEvent?: boolean; status?: string; customerId?: string | null; tableId?: string | null;
}
interface Props { open: boolean; onClose: () => void; onSaved: (r: { id: string }) => void; initial?: Initial }

const REASONS: Record<string, string> = {
  full: "Fully booked", pacing: "Cover limit for this slot", service_cap: "Service is full", notice: "Too soon", window: "Beyond booking window", past: "In the past", party_large: "Party too large", party_small: "Party too small", closed: "Closed",
};

export function ReservationForm({ open, onClose, onSaved, initial }: Props) {
  const { t, fmt } = useI18n();
  const { locationId, today, can } = useApp();
  const { toast, confirm } = useFeedback();
  const editing = !!initial?.id;

  const [f, setF] = useState({ date: "", time: "", partySize: 2, guestName: "", guestPhone: "", guestEmail: "", source: "phone", occasion: "", specialRequests: "", internalNotes: "", seatingPreference: "", isVip: false, isPrivateEvent: false, status: "confirmed", tableId: "auto" });
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [slots, setSlots] = useState<{ closed: boolean; closedLabel: string | null; slots: Slot[] } | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [tables, setTables] = useState<Array<{ id: string; name: string; capacity: number; sectionId: string | null }>>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [force, setForce] = useState(false);
  const [suggest, setSuggest] = useState<Array<{ id: string; name: string; phone: string | null; email: string | null; vip: boolean; visits: number; allergies: string[] }>>([]);
  const nameQ = useDebounced(f.guestName, 250);

  useEffect(() => {
    if (!open) return;
    setErr(null); setForce(false); setSuggest([]);
    setCustomerId(initial?.customerId ?? null);
    setF({
      date: initial?.date ?? today ?? "", time: initial?.time ?? "", partySize: initial?.partySize ?? 2, guestName: initial?.guestName ?? "", guestPhone: initial?.guestPhone ?? "", guestEmail: initial?.guestEmail ?? "",
      source: initial?.source ?? "phone", occasion: initial?.occasion ?? "", specialRequests: initial?.specialRequests ?? "", internalNotes: initial?.internalNotes ?? "", seatingPreference: initial?.seatingPreference ?? "",
      isVip: initial?.isVip ?? false, isPrivateEvent: initial?.isPrivateEvent ?? false, status: initial?.status === "pending" ? "pending" : "confirmed", tableId: initial?.tableId ?? "auto",
    });
  }, [open, initial, today]);

  useEffect(() => {
    if (!open || !can("floor.view") || !locationId) return;
    api.get(`/api/v1/floor/state?locationId=${locationId}`).then((r) => setTables(r.tables.map((x: { id: string; name: string; capacity: number; sectionId: string | null }) => ({ id: x.id, name: x.name, capacity: x.capacity, sectionId: x.sectionId })))).catch(() => undefined);
  }, [open, locationId, can]);

  useEffect(() => {
    if (!open || !locationId || !f.date || f.partySize < 1) return;
    let alive = true;
    setSlotsLoading(true);
    api.get(`/api/v1/availability${qs({ locationId, date: f.date, partySize: f.partySize, excludeReservationId: initial?.id })}`)
      .then((r) => alive && setSlots(r)).catch(() => alive && setSlots(null)).finally(() => alive && setSlotsLoading(false));
    return () => { alive = false; };
  }, [open, locationId, f.date, f.partySize, initial?.id]);

  useEffect(() => {
    if (!open || editing || customerId || nameQ.trim().length < 2 || !can("customers.read")) { setSuggest([]); return; }
    api.get(`/api/v1/customers${qs({ search: nameQ.trim(), limit: 5 })}`).then((r) => setSuggest(r.rows)).catch(() => setSuggest([]));
  }, [nameQ, open, editing, customerId, can]);

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const chosen = useMemo(() => slots?.slots.find((s) => s.time === f.time), [slots, f.time]);
  const fe = err?.fields ?? {};

  async function save(allowDuplicate = false) {
    if (!locationId) return;
    setBusy(true); setErr(null);
    const body = {
      date: f.date, time: f.time, partySize: f.partySize, guestName: f.guestName, guestPhone: f.guestPhone || null, guestEmail: f.guestEmail || null,
      occasion: f.occasion || null, specialRequests: f.specialRequests || null, internalNotes: f.internalNotes || null, seatingPreference: f.seatingPreference || null, isVip: f.isVip, isPrivateEvent: f.isPrivateEvent,
      tableIds: f.tableId !== "auto" && initial?.status !== "seated" ? [f.tableId] : undefined, force: force || undefined,
    };
    try {
      let r: { id: string };
      if (editing) { await api.patch(`/api/v1/reservations/${initial!.id}`, { ...body, tableIds: body.tableIds }); r = { id: initial!.id! }; toast.success(t("Reservation updated")); }
      else { r = await api.post("/api/v1/reservations", { ...body, locationId, source: f.source, status: f.status, customerId: customerId ?? undefined, allowDuplicate: allowDuplicate || undefined }); toast.success(t("Reservation created")); }
      onSaved(r); onClose();
    } catch (e) {
      const x = e as ApiError;
      if (x.code === "DUPLICATE_RESERVATION" && !allowDuplicate) {
        if (await confirm({ title: t("Possible duplicate"), message: x.message, confirmLabel: t("Create anyway") })) return save(true);
      } else setErr(x);
    } finally { setBusy(false); }
  }

  const grouped = useMemo(() => {
    const m = new Map<string, Slot[]>();
    for (const s of slots?.slots ?? []) m.set(s.serviceName, [...(m.get(s.serviceName) ?? []), s]);
    return [...m.entries()];
  }, [slots]);

  const canSubmit = f.date && f.time && f.guestName.trim() && f.partySize >= 1;

  return (
    <Dialog open={open} onClose={onClose} size="xl" title={editing ? t("Edit reservation") : t("New reservation")}
      description={editing ? undefined : t("Phone call, walk-in or social media inquiry")}
      footer={<><Button onClick={onClose}>{t("Cancel")}</Button><Button variant="primary" loading={busy} disabled={!canSubmit} onClick={() => save()}>{editing ? t("Save changes") : t("Create reservation")}</Button></>}>
      <div className="grid lg:grid-cols-2 gap-x-8 gap-y-5 pt-2">
        <div className="space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{t("When")}</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("Date")} error={fe.date}><Input type="date" value={f.date} onChange={(e) => set("date", e.target.value)} /></Field>
            <Field label={t("Guests")} error={fe.partySize}>
              <div className="flex items-center gap-1.5">
                <Button size="md" aria-label="−" onClick={() => set("partySize", Math.max(1, f.partySize - 1))}>−</Button>
                <Input type="number" min={1} max={500} value={f.partySize} onChange={(e) => set("partySize", Math.max(1, Number(e.target.value) || 1))} className="text-center" />
                <Button size="md" aria-label="+" onClick={() => set("partySize", f.partySize + 1)}>+</Button>
              </div>
            </Field>
          </div>
          <div>
            <div className="flex items-center justify-between mb-2"><span className="text-[13px] font-medium text-ink-2">{t("Time")}</span>{slotsLoading && <Spinner size={14} />}</div>
            {slots?.closed ? <Notice tone="warn">{slots.closedLabel ? `${t("Closed")}: ${slots.closedLabel}` : t("The restaurant is closed on this date.")}</Notice> : (
              <div className="space-y-3 max-h-56 overflow-y-auto scroll-thin pe-1">
                {grouped.map(([svc, list]) => (
                  <div key={svc}>
                    {grouped.length > 1 && <p className="text-xs text-muted mb-1.5">{svc}</p>}
                    <div className="flex flex-wrap gap-1.5">
                      {list.map((s) => {
                        const selected = f.time === s.time;
                        const ok = s.available || force;
                        return (
                          <button key={s.time} type="button" disabled={!ok} onClick={() => set("time", s.time)} title={s.available ? `${s.tables?.join(" + ") ?? ""}` : t(REASONS[s.reason ?? "full"] ?? "Unavailable")}
                            className={cx("h-9 min-w-[3.6rem] rounded-lg px-2.5 text-sm tabular border transition", selected ? "bg-charcoal text-white border-charcoal" : s.available ? "bg-surface border-line-strong hover:border-gold" : force ? "bg-warn-soft border-warn/30 text-warn" : "bg-sunken text-muted/60 border-transparent line-through cursor-not-allowed")}>
                            {s.time}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {!slots && !slotsLoading && <p className="text-sm text-muted">{t("Pick a date to see availability.")}</p>}
              </div>
            )}
            <div className="mt-3 flex items-center gap-3">
              <Input type="time" value={f.time} onChange={(e) => set("time", e.target.value)} className="!w-32" aria-label={t("Custom time")} />
              <span className="text-xs text-muted">{chosen ? (chosen.available ? `${chosen.durationMin} min · ${chosen.tables?.join(" + ") ?? ""}` : t(REASONS[chosen.reason ?? "full"] ?? "Unavailable")) : f.time ? t("Not a standard slot — the server will validate") : ""}</span>
            </div>
            {fe.time && <p className="text-xs text-bad mt-1">{fe.time}</p>}
            <div className="mt-3"><Switch checked={force} onChange={setForce} label={t("Override booking limits")} description={t("Allow times outside service hours or over cover limits. Tables can never be double-booked.")} /></div>
          </div>
          {initial?.status === "seated"
            ? <Field label={t("Table")} hint={t("This party is seated. To change its table, use “Move” on the reservation.")}><Input value={tables.find((x) => x.id === initial?.tableId)?.name ?? ""} disabled readOnly /></Field>
            : <Field label={t("Table")} hint={t("Auto-assign picks the best-fitting free table.")}>
            <Select value={f.tableId} onChange={(e) => set("tableId", e.target.value)}>
              <option value="auto">{t("Auto-assign")}{chosen?.tables?.length ? ` (${chosen.tables.join(" + ")})` : ""}</option>
              {tables.filter((x) => x.capacity >= f.partySize).map((x) => <option key={x.id} value={x.id}>{x.name} · {x.capacity}</option>)}
            </Select>
          </Field>}
        </div>

        <div className="space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{t("Guest")}</h3>
          <div className="relative">
            <Field label={t("Name")} error={fe.guestName} required>
              <Input value={f.guestName} onChange={(e) => { set("guestName", e.target.value); if (customerId && !editing) setCustomerId(null); }} autoComplete="off" />
            </Field>
            {suggest.length > 0 && (
              <ul className="absolute z-10 mt-1 w-full rounded-xl border border-line bg-surface shadow-[var(--shadow-pop)] overflow-hidden">
                {suggest.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="w-full text-start px-3 py-2 hover:bg-sunken flex items-center justify-between gap-2"
                      onClick={() => { setCustomerId(c.id); setF((s) => ({ ...s, guestName: c.name, guestPhone: c.phone ?? s.guestPhone, guestEmail: c.email ?? s.guestEmail, isVip: c.vip || s.isVip })); setSuggest([]); }}>
                      <span><b className="font-medium">{c.name}</b> <span className="text-muted text-xs">{c.phone ?? c.email ?? ""}</span></span>
                      <span className="flex gap-1">{c.vip && <Badge tone="gold">VIP</Badge>}{c.visits > 0 && <Badge>{c.visits} {t("visits")}</Badge>}{c.allergies.length > 0 && <Badge tone="bad">{t("Allergy")}</Badge>}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {customerId && <div className="flex items-center gap-2 text-xs text-ok -mt-2"><Icon name="check" size={14} />{t("Linked to an existing guest profile")}{!editing && <button type="button" className="underline text-muted" onClick={() => setCustomerId(null)}>{t("unlink")}</button>}</div>}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("Phone")} error={fe.guestPhone}><Input type="tel" inputMode="tel" value={f.guestPhone} onChange={(e) => set("guestPhone", e.target.value)} placeholder="06 12 34 56 78" /></Field>
            <Field label={t("Email")} error={fe.guestEmail}><Input type="email" value={f.guestEmail} onChange={(e) => set("guestEmail", e.target.value)} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {!editing && <Field label={t("Source")}><Select value={f.source} onChange={(e) => set("source", e.target.value)}>{SOURCES.filter((s) => s !== "online").map((s) => <option key={s} value={s}>{t(SOURCE_LABEL[s])}</option>)}</Select></Field>}
            <Field label={t("Occasion")}><Select value={f.occasion} onChange={(e) => set("occasion", e.target.value)}><option value="">—</option>{OCCASIONS.map((o) => <option key={o} value={o}>{t(o)}</option>)}</Select></Field>
          </div>
          <Field label={t("Special requests")} hint={t("Visible to the whole team (allergies, celebrations…).")}><Textarea rows={2} value={f.specialRequests} onChange={(e) => set("specialRequests", e.target.value)} /></Field>
          <Field label={t("Internal notes")} hint={t("Staff only. Never shown to the guest.")}><Textarea rows={2} value={f.internalNotes} onChange={(e) => set("internalNotes", e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("Seating preference")}><Input value={f.seatingPreference} onChange={(e) => set("seatingPreference", e.target.value)} placeholder={t("Terrace, quiet corner…")} /></Field>
            {!editing && <Field label={t("Status")}><Select value={f.status} onChange={(e) => set("status", e.target.value)}><option value="confirmed">{t("Confirmed")}</option><option value="pending">{t("Pending")}</option></Select></Field>}
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <Switch checked={f.isVip} onChange={(v) => set("isVip", v)} label={<span className="inline-flex items-center gap-1.5"><Icon name="crown" size={15} className="text-gold" />{t("VIP guest")}</span>} />
            <Switch checked={f.isPrivateEvent} onChange={(v) => set("isPrivateEvent", v)} label={t("Private event / large group")} />
          </div>
        </div>
      </div>
      {err && !Object.keys(fe).length && <div className="mt-4"><Notice tone="bad" title={err.code === "NO_AVAILABILITY" ? t("No table available") : undefined}>{err.message}</Notice></div>}
    </Dialog>
  );
}
