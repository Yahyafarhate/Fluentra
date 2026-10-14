"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useApp, NoAccess } from "@/components/app-shell";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, IconButton, Input, PageHeader, Select, Skeleton, Stat, StatusBadge } from "@/components/ui";
import { Icon } from "@/components/icons";
import { BarChart, HBar, LineChart, Meter } from "@/components/charts";
import { ReservationForm } from "@/components/reservation-form";
import { ReservationDrawer } from "@/components/reservation-drawer";
import { WalkInDialog } from "@/components/walkin-dialog";
import { useI18n } from "@/lib/i18n/client";
import { qs } from "@/lib/client/api";
import { useApi, useLive } from "@/lib/client/hooks";
import { shiftDate } from "@/lib/client/format";

export default function DashboardPage() {
  const { t, fmt } = useI18n();
  const { can, locationId, me, today } = useApp();
  const [date, setDate] = useState<string | null>(null);
  const [span, setSpan] = useState<"1" | "7" | "30">("1");
  const [scope, setScope] = useState<"one" | "all">("one");
  const [serviceId, setServiceId] = useState("");
  const [form, setForm] = useState(false); const [walk, setWalk] = useState(false); const [open, setOpen] = useState<string | null>(null); const [edit, setEdit] = useState<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any

  const day = date ?? today;
  const range = useMemo(() => (day ? { from: span === "1" ? day : shiftDate(day, -(Number(span) - 1)), to: day } : null), [day, span]);
  const url = range && (scope === "all" || locationId) ? `/api/v1/dashboard${qs({ locationId: scope === "one" ? locationId : undefined, from: range.from, to: range.to, serviceId })}` : null;
  const { data: d, error, loading, reload, refreshing } = useApi<any>(url); // eslint-disable-line @typescript-eslint/no-explicit-any
  const live = useLive(locationId, reload);

  if (!can("dashboard.view")) return <NoAccess />;
  const isToday = !!range && !!d && !d.empty && range.to === d.range.today;
  const money = (n: number) => fmt.money(n, d?.revenue?.currency);

  return (
    <>
      <PageHeader title={t("Dashboard")} subtitle={d && !d.empty ? <span className="inline-flex items-center gap-2"><span className={`size-2 rounded-full ${live === "live" ? "bg-ok animate-[fl-pulse_2s_infinite]" : "bg-warn"}`} />{live === "live" ? t("Live") : t("Auto-refresh every 30s")} · {t("updated {time}", { time: fmt.date(d.generatedAt, { timeStyle: "medium" }) })}{refreshing ? " …" : ""}</span> : undefined}
        actions={<>
          {can("reservations.write") && <Button variant="primary" icon="plus" onClick={() => { setEdit(null); setForm(true); }}>{t("New reservation")}</Button>}
          {can("reservations.operate") && <Button icon="utensils" onClick={() => setWalk(true)}>{t("Walk-in")}</Button>}
          {can("waitlist.manage") && <Link href="/app/waitlist"><Button icon="clock">{t("Waitlist")}</Button></Link>}
        </>} />

      <Card className="!p-3 mb-6 flex flex-wrap items-center gap-2">
        <IconButton icon="chevronLeft" label={t("Previous day")} onClick={() => day && setDate(shiftDate(day, -1))} className="rtl:rotate-180" />
        <Input type="date" value={day ?? ""} onChange={(e) => setDate(e.target.value || null)} className="!w-40" aria-label={t("Date")} />
        <IconButton icon="chevronRight" label={t("Next day")} onClick={() => day && setDate(shiftDate(day, 1))} className="rtl:rotate-180" />
        <Button size="sm" onClick={() => setDate(today)} disabled={!today || day === today}>{t("Today")}</Button>
        <Select value={span} onChange={(e) => setSpan(e.target.value as typeof span)} className="!w-auto" aria-label={t("Range")}><option value="1">{t("Single day")}</option><option value="7">{t("Last 7 days")}</option><option value="30">{t("Last 30 days")}</option></Select>
        {me.locations.length > 1 && <Select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} className="!w-auto" aria-label={t("Location")}><option value="one">{t("This location")}</option><option value="all">{t("All my locations")}</option></Select>}
        {d && !d.empty && d.availableServices.length > 0 && <Select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className="!w-auto" aria-label={t("Service")}><option value="">{t("All services")}</option>{d.availableServices.map((s: { id: string; name: string }) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}
      </Card>

      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>}
      {d?.empty && <Card><EmptyState icon="building" title={t("No location yet")}>{t("Create a restaurant location in Settings to see live figures here.")}</EmptyState></Card>}

      {d && !d.empty && (
        <div className="space-y-6">
          <section className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
            <Stat icon="calendar" label={t("Reservations")} value={d.totals.reservations} sub={`${d.totals.pending} ${t("pending")} · ${d.totals.confirmed} ${t("confirmed")}`} />
            <Stat icon="users" label={t("Expected covers")} value={d.totals.covers} sub={isToday ? `${d.totals.expectedRemainingCovers} ${t("still to arrive")}` : t("booked guests")} />
            <Stat icon="user" label={t("Arrivals")} value={d.arrivals} sub={`${d.totals.arrived} ${t("waiting")} · ${d.totals.seated} ${t("seated")} · ${d.totals.completed} ${t("done")}`} />
            <Stat icon="utensils" label={t("Walk-ins")} value={d.totals.walkIns} sub={`${d.totals.walkInCovers} ${t("covers")}`} />
            <Stat icon="x" label={t("Cancellations")} value={d.totals.cancelled} tone={d.totals.cancelled ? "bad" : undefined} />
            <Stat icon="ban" label={t("No-shows")} value={d.totals.noShow} tone={d.totals.noShow ? "bad" : undefined} />
            <Stat icon="crown" label={t("VIP bookings")} value={d.totals.vipCount} />
            <Stat icon="card" label={t("Revenue (recorded)")} value={d.revenue.recorded != null ? money(d.revenue.recorded) : "—"} sub={d.revenue.avgSpendPerGuest != null ? `${money(d.revenue.avgSpendPerGuest)} ${t("avg / guest")}` : t("no spend recorded")} />
          </section>
          {d.revenue.note && <p className="text-xs text-muted -mt-3 flex items-center gap-1.5"><Icon name="info" size={14} />{t(d.revenue.note)}</p>}

          <div className="grid xl:grid-cols-3 gap-6">
            <div className="xl:col-span-2 space-y-6">
              {d.occupancy && (
                <Card>
                  <CardHeader title={t("Tables right now")} subtitle={`${d.occupancy.tables} ${t("tables")} · ${d.occupancy.seats} ${t("seats")} · ${d.occupancy.seatedGuests} ${t("guests seated")}`} action={can("floor.view") ? <Link href="/app/floor"><Button size="sm" icon="floor">{t("Open floor plan")}</Button></Link> : undefined} />
                  <div className="flex h-3 rounded-full overflow-hidden bg-sunken" role="img" aria-label="table status distribution">
                    {([["occupied", "bg-violet"], ["reserved", "bg-info"], ["cleaning", "bg-warn"], ["blocked", "bg-bad"], ["available", "bg-ok"]] as const).map(([k, c]) => d.occupancy[k] > 0 && <div key={k} className={c} style={{ width: `${(100 * d.occupancy[k]) / d.occupancy.tables}%` }} title={`${k}: ${d.occupancy[k]}`} />)}
                  </div>
                  <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
                    {(["available", "reserved", "occupied", "cleaning", "blocked"] as const).map((k) => <li key={k} className="flex items-center gap-1.5"><StatusBadge status={k} label={`${t(k.charAt(0).toUpperCase() + k.slice(1))} ${d.occupancy[k]}`} /></li>)}
                  </ul>
                </Card>
              )}
              <Card pad={false}>
                <div className="p-5 pb-3"><CardHeader title={t("Upcoming reservations")} subtitle={t("Next arrivals, in time order")} action={<Link href="/app/reservations" className="text-sm text-gold-strong hover:underline">{t("View all")}</Link>} /></div>
                {d.upcoming.length === 0 ? <EmptyState icon="calendar" title={t("Nothing coming up")}>{t("No pending or confirmed reservations for this period.")}</EmptyState> : (
                  <ul className="divide-y divide-line">
                    {d.upcoming.map((r: any) => ( // eslint-disable-line @typescript-eslint/no-explicit-any
                      <li key={r.id}><button className="w-full text-start px-5 py-3 flex items-center gap-4 hover:bg-canvas transition" onClick={() => setOpen(r.id)}>
                        <span className="tabular font-semibold w-14">{r.time}</span>
                        <span className="min-w-0 flex-1"><span className="font-medium truncate flex items-center gap-1.5">{r.guestName}{r.isVip && <Icon name="crown" size={14} className="text-gold" />}</span>
                          <span className="text-xs text-muted truncate block">{r.partySize} {t("guests")}{r.tableNames ? ` · ${r.tableNames}` : ""}{r.occasion ? ` · ${r.occasion}` : ""}{d.locations.length > 1 ? ` · ${r.locationName}` : ""}</span></span>
                        <StatusBadge status={r.status} />
                      </button></li>
                    ))}
                  </ul>
                )}
              </Card>
              <div className="grid md:grid-cols-2 gap-6">
                <Card><CardHeader title={t("Covers by hour")} subtitle={t("Booked guests by arrival time")} />
                  {d.byHour.length ? <BarChart data={d.byHour.map((h: { hour: number; covers: number; reservations: number }) => ({ label: `${h.hour}h`, value: h.covers, sub: `${h.reservations} ${t("reservations")}` }))} /> : <p className="text-sm text-muted py-8 text-center">{t("No data for this period.")}</p>}</Card>
                <Card><CardHeader title={t("Service performance")} subtitle={t("Covers per service")} />
                  {d.services.length ? <HBar rows={d.services.map((s: { service: string; covers: number; reservations: number }) => ({ label: s.service, value: s.covers, sub: `${s.reservations} ${t("res.")}` }))} /> : <p className="text-sm text-muted py-8 text-center">{t("No data for this period.")}</p>}</Card>
              </div>
              <Card><CardHeader title={t("14-day trend")} subtitle={t("Reservations and covers per day (cancelled and no-shows excluded)")} />
                <LineChart labels={d.trend.map((x: { date: string }) => x.date.slice(5))} series={[{ name: t("Covers"), values: d.trend.map((x: { covers: number }) => x.covers), color: "#a8803f" }, { name: t("Reservations"), values: d.trend.map((x: { reservations: number }) => x.reservations), color: "#3c6e8f" }]} /></Card>
            </div>
            <div className="space-y-6">
              {d.waitlist && (
                <Card><CardHeader title={t("Waitlist")} action={can("waitlist.manage") ? <Link href="/app/waitlist" className="text-sm text-gold-strong hover:underline">{t("Manage")}</Link> : undefined} />
                  <div className="grid grid-cols-2 gap-3 text-center">
                    <div className="rounded-xl bg-sunken p-3"><p className="text-2xl font-semibold">{d.waitlist.waiting + d.waitlist.notified}</p><p className="text-xs text-muted">{t("waiting now")}</p></div>
                    <div className="rounded-xl bg-sunken p-3"><p className="text-2xl font-semibold">{d.waitlist.avgWaitMin ?? "—"}{d.waitlist.avgWaitMin != null && <span className="text-sm font-normal"> min</span>}</p><p className="text-xs text-muted">{t("avg wait (30 d)")}</p></div>
                  </div>
                  {d.waitlist.conversionPct != null && <div className="mt-3 text-sm"><div className="flex justify-between mb-1"><span className="text-muted">{t("Seated conversion (30 d)")}</span><b>{d.waitlist.conversionPct}%</b></div><Meter value={d.waitlist.conversionPct} max={100} tone="ok" /></div>}
                </Card>
              )}
              <Card pad={false}>
                <div className="p-5 pb-3"><CardHeader title={t("VIPs & special requests")} subtitle={t("Allergies, occasions and VIP guests to prepare for")} /></div>
                {d.vips.length === 0 ? <p className="text-sm text-muted px-5 pb-6">{t("Nothing special to prepare for.")}</p> : (
                  <ul className="divide-y divide-line">
                    {d.vips.map((r: any) => ( // eslint-disable-line @typescript-eslint/no-explicit-any
                      <li key={r.id}><button className="w-full text-start px-5 py-3 hover:bg-canvas" onClick={() => setOpen(r.id)}>
                        <div className="flex items-center justify-between gap-2"><span className="font-medium truncate">{r.guestName}</span><span className="tabular text-sm text-muted">{r.time} · {r.partySize}p</span></div>
                        <div className="flex flex-wrap gap-1.5 mt-1.5">{r.occasion && <Badge tone="gold">{r.occasion}</Badge>}{r.allergies?.map((a: string) => <Badge key={a} tone="bad">⚠ {a}</Badge>)}{r.specialRequests && <span className="text-xs text-ink-2">{r.specialRequests}</span>}</div>
                      </button></li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        </div>
      )}

      <ReservationForm open={form} onClose={() => setForm(false)} onSaved={() => reload()} initial={edit ?? undefined} />
      <WalkInDialog open={walk} onClose={() => setWalk(false)} onDone={reload} />
      <ReservationDrawer id={open} onClose={() => setOpen(null)} onChanged={reload} onEdit={(r) => { setEdit({ id: r.id, date: r.serviceDate, time: r.time, partySize: r.partySize, guestName: r.guestName, guestPhone: r.guestPhone, guestEmail: r.guestEmail, source: r.source, occasion: r.occasion, specialRequests: r.specialRequests, internalNotes: r.internalNotes, seatingPreference: r.seatingPreference, isVip: r.isVip, status: r.status, customerId: r.customerId }); setOpen(null); setForm(true); }} />
    </>
  );
}
