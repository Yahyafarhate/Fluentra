"use client";
import { useEffect, useMemo, useState } from "react";
import { useApp, NoAccess } from "@/components/app-shell";
import { Badge, Button, Card, EmptyState, ErrorState, IconButton, Input, PageHeader, Segmented, Select, Skeleton, StatusBadge, cx } from "@/components/ui";
import { Icon } from "@/components/icons";
import { ReservationForm } from "@/components/reservation-form";
import { ReservationDrawer } from "@/components/reservation-drawer";
import { WalkInDialog } from "@/components/walkin-dialog";
import { useFeedback } from "@/components/feedback";
import { useI18n } from "@/lib/i18n/client";
import { api, qs } from "@/lib/client/api";
import { useApi, useDebounced, useLive } from "@/lib/client/hooks";
import { SOURCE_LABEL, SOURCES, shiftDate } from "@/lib/client/format";

const STATUSES = ["pending", "confirmed", "arrived", "seated", "completed", "cancelled", "no_show"];

export default function ReservationsPage() {
  const { t, fmt } = useI18n();
  const { can, locationId, today } = useApp();
  const { toast } = useFeedback();
  const [view, setView] = useState<"list" | "calendar">("list");
  const [date, setDate] = useState<string | null>(null);
  const [allDates, setAllDates] = useState(false);
  const [q, setQ] = useState(""); const dq = useDebounced(q, 300);
  const [status, setStatus] = useState<string>(""); const [source, setSource] = useState("");
  const [minParty, setMinParty] = useState(""); const [timeFrom, setTimeFrom] = useState(""); const [timeTo, setTimeTo] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [form, setForm] = useState(false); const [walk, setWalk] = useState(false); const [open, setOpen] = useState<string | null>(null); const [edit, setEdit] = useState<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [month, setMonth] = useState<string | null>(null);

  useEffect(() => { const q0 = new URLSearchParams(window.location.search).get("q"); if (q0) { setQ(q0); setShowFilters(true); } }, []);
  const day = date ?? today;
  useEffect(() => { if (!month && day) setMonth(day.slice(0, 7)); }, [day, month]);
  const searching = dq.trim().length > 0;
  const base = today ?? day ?? "";
  const params = useMemo(() => ({
    locationId, date: !allDates && !searching ? day : undefined, from: searching && base ? shiftDate(base, -365) : undefined, to: searching && base ? shiftDate(base, 365) : undefined,
    q: dq || undefined, status: status || undefined, source: source || undefined, minParty: minParty || undefined, timeFrom: timeFrom || undefined, timeTo: timeTo || undefined, limit: 300,
  }), [locationId, day, allDates, searching, base, dq, status, source, minParty, timeFrom, timeTo]);
  const ready = !!locationId && (!!day || allDates);
  const { data, error, loading, reload } = useApi<{ reservations: any[] }>(ready && view === "list" ? `/api/v1/reservations${qs(params)}` : null); // eslint-disable-line @typescript-eslint/no-explicit-any
  useLive(locationId, reload);

  // counts per status for the quick-filter chips (computed from the unfiltered-by-status day)
  const { data: dayAll, reload: reloadAll } = useApi<{ reservations: any[] }>(ready && view === "list" && !searching && !allDates ? `/api/v1/reservations${qs({ locationId, date: day, limit: 500 })}` : null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const counts = useMemo(() => { const c: Record<string, number> = {}; for (const r of dayAll?.reservations ?? []) c[r.status] = (c[r.status] ?? 0) + 1; return c; }, [dayAll]);
  const refresh = () => { reload(); reloadAll(); };

  const monthTo = month ? new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10) : null;
  const cal = useApi<{ days: Array<{ date: string; reservations: number; covers: number; pending: number }> }>(view === "calendar" && locationId && month && monthTo ? `/api/v1/reservations/calendar${qs({ locationId, from: `${month}-01`, to: monthTo })}` : null);

  if (!can("reservations.read")) return <NoAccess />;

  async function quick(id: string, action: string, label: string) {
    try { await api.post(`/api/v1/reservations/${id}/transition`, { action }); toast.success(label); refresh(); } catch (e) { toast.error(e); }
  }

  const rows = data?.reservations ?? [];
  const filtered = !!(status || source || minParty || timeFrom || timeTo);

  return (
    <>
      <PageHeader title={t("Reservations")} subtitle={day && !allDates && !searching ? fmt.date(day, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : searching ? t("Search results") : t("All dates")}
        actions={<>
          <Segmented value={view} onChange={setView} options={[{ value: "list", label: <span className="inline-flex items-center gap-1.5"><Icon name="list" size={15} />{t("List")}</span> }, { value: "calendar", label: <span className="inline-flex items-center gap-1.5"><Icon name="calendar" size={15} />{t("Calendar")}</span> }]} />
          {can("reservations.operate") && <Button icon="utensils" onClick={() => setWalk(true)}>{t("Walk-in")}</Button>}
          {can("reservations.write") && <Button variant="primary" icon="plus" onClick={() => { setEdit(null); setForm(true); }}>{t("New reservation")}</Button>}
        </>} />

      {view === "calendar" ? (
        <Card>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-1"><IconButton icon="chevronLeft" label={t("Previous month")} className="rtl:rotate-180" onClick={() => month && setMonth(shiftDate(`${month}-01`, -1).slice(0, 7))} />
              <h2 className="text-xl font-semibold min-w-44 text-center">{month ? fmt.date(`${month}-01`, { month: "long", year: "numeric" }) : ""}</h2>
              <IconButton icon="chevronRight" label={t("Next month")} className="rtl:rotate-180" onClick={() => month && setMonth(shiftDate(`${month}-01`, 32).slice(0, 7))} /></div>
            <Button size="sm" onClick={() => today && setMonth(today.slice(0, 7))}>{t("Today")}</Button>
          </div>
          {month && <MonthGrid month={month} today={today} days={cal.data?.days ?? []} loading={cal.loading} onPick={(d) => { setDate(d); setView("list"); }} />}
        </Card>
      ) : (
        <>
          <Card className="!p-3 mb-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-52"><Icon name="search" size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Search name, phone, email or code…")} className="!ps-9" aria-label={t("Search")} /></div>
              <IconButton icon="chevronLeft" label={t("Previous day")} className="rtl:rotate-180" onClick={() => day && setDate(shiftDate(day, -1))} disabled={allDates || searching} />
              <Input type="date" value={day ?? ""} onChange={(e) => { setDate(e.target.value || null); setAllDates(false); }} className="!w-40" disabled={allDates || searching} aria-label={t("Date")} />
              <IconButton icon="chevronRight" label={t("Next day")} className="rtl:rotate-180" onClick={() => day && setDate(shiftDate(day, 1))} disabled={allDates || searching} />
              <Button size="sm" onClick={() => { setDate(today); setAllDates(false); }} disabled={!today || (day === today && !allDates)}>{t("Today")}</Button>
              <Button size="sm" variant={showFilters || filtered ? "subtle" : "secondary"} icon="filter" onClick={() => setShowFilters(!showFilters)}>{t("Filters")}{filtered && <Badge tone="gold">•</Badge>}</Button>
            </div>
            {showFilters && (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 animate-in">
                <Select value={source} onChange={(e) => setSource(e.target.value)} aria-label={t("Source")}><option value="">{t("Any source")}</option>{SOURCES.map((s) => <option key={s} value={s}>{t(SOURCE_LABEL[s])}</option>)}</Select>
                <Input type="number" min={1} placeholder={t("Min. party size")} value={minParty} onChange={(e) => setMinParty(e.target.value)} aria-label={t("Min. party size")} />
                <Input type="time" value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} aria-label={t("From time")} />
                <Input type="time" value={timeTo} onChange={(e) => setTimeTo(e.target.value)} aria-label={t("To time")} />
                <label className="flex items-center gap-2 text-sm px-2"><input type="checkbox" className="size-4 accent-[var(--color-gold)]" checked={allDates} onChange={(e) => setAllDates(e.target.checked)} />{t("All dates")}</label>
              </div>
            )}
            <div className="flex flex-wrap gap-1.5">
              <button onClick={() => setStatus("")} className={cx("rounded-full px-3 h-8 text-sm border transition", !status ? "bg-charcoal text-white border-charcoal" : "bg-surface border-line-strong hover:bg-sunken")}>{t("All")}{!searching && !allDates ? <span className="opacity-60"> {dayAll?.reservations.length ?? ""}</span> : null}</button>
              {STATUSES.map((s) => <button key={s} onClick={() => setStatus(status === s ? "" : s)} className={cx("rounded-full px-3 h-8 text-sm border transition", status === s ? "bg-charcoal text-white border-charcoal" : "bg-surface border-line-strong hover:bg-sunken")}>{t(s === "no_show" ? "No-show" : s.charAt(0).toUpperCase() + s.slice(1))}{counts[s] ? <span className="opacity-60"> {counts[s]}</span> : null}</button>)}
            </div>
          </Card>

          {error && <ErrorState error={error} onRetry={reload} />}
          {loading && <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>}
          {data && rows.length === 0 && (
            <Card><EmptyState icon="calendar" title={searching || filtered ? t("No reservation matches") : t("No reservations for this day")}
              action={can("reservations.write") ? <Button variant="primary" icon="plus" onClick={() => { setEdit(null); setForm(true); }}>{t("New reservation")}</Button> : undefined}>
              {searching || filtered ? t("Try a different search or clear the filters.") : t("Reservations from the booking page, phone calls and walk-ins will appear here.")}</EmptyState></Card>
          )}
          {rows.length > 0 && (
            <ul className="space-y-2">
              {rows.map((r) => (
                <li key={r.id}>
                  <div className={cx("rounded-xl border bg-surface flex flex-wrap md:flex-nowrap items-center gap-x-4 gap-y-2 px-4 py-3 hover:border-gold/60 transition cursor-pointer", r.status === "seated" ? "border-ok/40" : r.status === "arrived" ? "border-violet/40" : "border-line")}
                    onClick={() => setOpen(r.id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setOpen(r.id); }}>
                    <div className="w-16 shrink-0"><p className="font-semibold tabular text-lg leading-none">{r.time}</p>{(allDates || searching) && <p className="text-[11px] text-muted mt-1">{fmt.date(r.serviceDate, { day: "numeric", month: "short" })}</p>}</div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate flex items-center gap-1.5">{r.guestName}{(r.isVip || r.customerVip) && <Icon name="crown" size={14} className="text-gold" />}
                        {r.allergies?.length > 0 && <span title={r.allergies.join(", ")} className="text-bad"><Icon name="alert" size={14} /></span>}
                        {r.isPrivateEvent && <Badge tone="violet">{t("Event")}</Badge>}</p>
                      <p className="text-xs text-muted truncate">{r.guestPhone ?? r.guestEmail ?? "—"}{r.occasion ? ` · ${r.occasion}` : ""}{r.specialRequests ? ` · ${r.specialRequests}` : ""}</p>
                    </div>
                    <div className="flex items-center gap-1 text-sm w-16 shrink-0"><Icon name="users" size={15} className="text-muted" />{r.partySize}</div>
                    <div className="hidden sm:flex w-24 shrink-0 gap-1 flex-wrap">{r.tables.length ? r.tables.map((x: { id: string; name: string }) => <Badge key={x.id} tone="dark">{x.name}</Badge>) : <span className="text-xs text-muted">—</span>}</div>
                    <div className="hidden lg:block w-20 text-xs text-muted shrink-0">{t(SOURCE_LABEL[r.source] ?? r.source)}</div>
                    <div className="w-28 shrink-0"><StatusBadge status={r.status} /></div>
                    <div className="flex gap-1.5 shrink-0 ms-auto" onClick={(e) => e.stopPropagation()}>
                      {can("reservations.operate") && r.status === "pending" && <Button size="sm" variant="primary" onClick={() => quick(r.id, "confirm", t("Reservation confirmed"))}>{t("Confirm")}</Button>}
                      {can("reservations.operate") && r.status === "confirmed" && <Button size="sm" variant="primary" onClick={() => quick(r.id, "arrive", t("Guest arrived"))}>{t("Arrived")}</Button>}
                      {can("reservations.operate") && r.status === "arrived" && <Button size="sm" variant="gold" onClick={() => quick(r.id, "seat", t("Guests seated"))}>{t("Seat")}</Button>}
                      {can("reservations.operate") && r.status === "seated" && <Button size="sm" onClick={() => setOpen(r.id)}>{t("Complete…")}</Button>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {rows.length > 0 && <p className="text-xs text-muted mt-3">{t("{n} reservations · {c} covers", { n: rows.filter((r) => !["cancelled", "no_show"].includes(r.status)).length, c: rows.filter((r) => !["cancelled", "no_show"].includes(r.status)).reduce((n, r) => n + r.partySize, 0) })}</p>}
        </>
      )}

      <ReservationForm open={form} onClose={() => setForm(false)} onSaved={refresh} initial={edit ?? undefined} />
      <WalkInDialog open={walk} onClose={() => setWalk(false)} onDone={refresh} />
      <ReservationDrawer id={open} onClose={() => setOpen(null)} onChanged={refresh}
        onEdit={(r) => { setEdit({ id: r.id, date: r.serviceDate, time: r.time, partySize: r.partySize, guestName: r.guestName, guestPhone: r.guestPhone, guestEmail: r.guestEmail, source: r.source, occasion: r.occasion, specialRequests: r.specialRequests, internalNotes: r.internalNotes, seatingPreference: r.seatingPreference, isVip: r.isVip, status: r.status, customerId: r.customerId }); setOpen(null); setForm(true); }} />
    </>
  );
}

function MonthGrid({ month, today, days, loading, onPick }: { month: string; today: string | null; days: Array<{ date: string; reservations: number; covers: number; pending: number }>; loading: boolean; onPick: (d: string) => void }) {
  const { t, fmt } = useI18n();
  const first = new Date(`${month}-01T00:00:00Z`);
  const offset = (first.getUTCDay() + 6) % 7; // Monday first
  const n = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const by = new Map(days.map((d) => [d.date, d]));
  const max = Math.max(1, ...days.map((d) => d.covers));
  const wd = Array.from({ length: 7 }, (_, i) => fmt.date(new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10), { weekday: "short" }));
  return (
    <div className={cx(loading && "opacity-60 transition")}>
      <div className="grid grid-cols-7 gap-1.5 text-center text-xs text-muted mb-1.5">{wd.map((w) => <div key={w}>{w}</div>)}</div>
      <div className="grid grid-cols-7 gap-1.5">
        {Array.from({ length: offset }).map((_, i) => <div key={`e${i}`} />)}
        {Array.from({ length: n }).map((_, i) => {
          const date = `${month}-${String(i + 1).padStart(2, "0")}`;
          const d = by.get(date);
          return (
            <button key={date} onClick={() => onPick(date)} className={cx("relative aspect-[1/0.9] sm:aspect-[1/0.75] rounded-xl border p-1.5 sm:p-2 text-start transition hover:border-gold", date === today ? "border-gold bg-gold-soft/40" : "border-line bg-surface")} aria-label={`${date}: ${d?.reservations ?? 0} reservations`}>
              <span className={cx("text-sm font-medium", date === today && "text-gold-strong")}>{i + 1}</span>
              {d && d.reservations > 0 && (<>
                <span className="block text-[11px] text-ink-2 mt-0.5 tabular">{d.reservations} {t("res.")}</span>
                <span className="block text-[11px] text-muted tabular">{d.covers} {t("covers")}</span>
                <span className="absolute bottom-1.5 inset-x-1.5 h-1 rounded-full bg-sunken overflow-hidden"><span className="block h-full bg-gold" style={{ width: `${(100 * d.covers) / max}%` }} /></span>
                {d.pending > 0 && <span className="absolute top-1.5 end-1.5 size-2 rounded-full bg-warn" title={`${d.pending} ${t("pending")}`} />}
              </>)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
