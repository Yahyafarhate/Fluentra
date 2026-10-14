"use client";
import { useMemo, useState } from "react";
import { useApp, NoAccess } from "@/components/app-shell";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Input, Notice, PageHeader, Segmented, Select, Skeleton, Stat, TableWrap, Td, Th } from "@/components/ui";
import { BarChart, HBar, LineChart, Meter } from "@/components/charts";
import { Icon } from "@/components/icons";
import { useI18n } from "@/lib/i18n/client";
import { qs } from "@/lib/client/api";
import { useApi } from "@/lib/client/hooks";
import { SOURCE_LABEL, shiftDate } from "@/lib/client/format";

export default function AnalyticsPage() {
  const { t, fmt } = useI18n();
  const { can, today, me, locationId, hasFeature } = useApp();
  const [preset, setPreset] = useState("30"); const [custom, setCustom] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [scope, setScope] = useState<"one" | "all">("one"); const [show, setShow] = useState(false);
  const range = useMemo(() => {
    if (!today) return null;
    if (preset === "custom") return custom.from && custom.to ? custom : null;
    if (preset === "month") return { from: today.slice(0, 8) + "01", to: today };
    return { from: shiftDate(today, -(Number(preset) - 1)), to: today };
  }, [preset, today, custom]);
  const loc = scope === "one" ? locationId : undefined;
  const { data: a, error, loading, reload } = useApi<any>(range && can("analytics.view") ? `/api/v1/analytics${qs({ ...range, locationId: loc })}` : null);  
  const fc = useApi<any>(can("analytics.view") && hasFeature("forecasting") ? `/api/v1/analytics/forecast${qs({ locationId: loc })}` : null);  
  if (!can("analytics.view")) return <NoAccess />;
  const wd = (n: number) => fmt.date(new Date(Date.UTC(2024, 0, n)).toISOString().slice(0, 10), { weekday: "short" });
  const money = (n: number) => fmt.money(n);
  const exportable = can("analytics.export") && hasFeature("analytics_export");

  return (
    <>
      <PageHeader title={t("Analytics & reports")} subtitle={a ? t("{from} → {to} · {n} location(s) · time zone of each restaurant", { from: a.range.from, to: a.range.to, n: a.locations.length }) : undefined}
        actions={<>{exportable && range && <><a href={`/api/v1/analytics/export.csv${qs({ ...range, locationId: loc })}`}><Button icon="download">{t("Reservations CSV")}</Button></a><a href={`/api/v1/analytics/summary.csv${qs({ ...range, locationId: loc })}`}><Button icon="download">{t("Daily CSV")}</Button></a></>}<Button icon="print" onClick={() => window.print()}>{t("Print / PDF")}</Button></>} />
      <Card className="!p-3 mb-6 flex flex-wrap items-center gap-2 no-print">
        <Segmented value={preset} onChange={setPreset} options={[{ value: "7", label: t("7 days") }, { value: "30", label: t("30 days") }, { value: "90", label: t("90 days") }, { value: "month", label: t("This month") }, { value: "custom", label: t("Custom") }]} />
        {preset === "custom" && <><Input type="date" className="!w-40" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label={t("From")} /><Input type="date" className="!w-40" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label={t("To")} /></>}
        {me.locations.length > 1 && <Select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} className="!w-auto"><option value="one">{t("This location")}</option><option value="all">{t("Compare all locations")}</option></Select>}
        <button className="ms-auto text-sm text-gold-strong hover:underline inline-flex items-center gap-1" onClick={() => setShow(!show)}><Icon name="info" size={14} />{t("Metric definitions")}</button>
      </Card>
      {show && <Card className="mb-6 text-sm"><CardHeader title={t("How each metric is defined")} />
        <dl className="grid md:grid-cols-2 gap-x-8 gap-y-2.5 text-ink-2">{[
          ["Reservations", "Bookings excluding cancelled and no-show (the guest party, not people)."], ["Covers", "Sum of party sizes of those reservations (people)."],
          ["Cancellation rate", "Cancelled ÷ all bookings made for the period."], ["No-show rate", "No-shows ÷ (bookings that were honoured or missed: completed, seated, arrived, no-show)."],
          ["Avg seating duration", "Measured from seated to left on completed visits only."], ["Table utilization", "Occupied table-minutes of completed visits ÷ (active tables × scheduled service minutes). Different from covers or bookings."],
          ["Waitlist conversion", "Waitlist entries seated ÷ all entries joined in the period."], ["First-time vs returning", "A visit is “returning” if the guest has an earlier recorded visit."],
          ["Revenue & avg spend", "Measured only from spend entered per visit (or a POS). Visits without spend are excluded; coverage is always shown."], ["Forecast", "An ESTIMATE: average of the same weekday over the last 8 weeks, never below what is already booked."],
        ].map(([k, v]) => <div key={k}><dt className="font-medium text-ink">{t(k)}</dt><dd className="text-xs">{t(v)}</dd></div>)}</dl></Card>}
      {error && <ErrorState error={error} onRetry={reload} />}
      {(loading || !range) && <div className="grid grid-cols-2 md:grid-cols-4 gap-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>}
      {a && (
        <div className="space-y-6">
          <section className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
            <Stat icon="calendar" label={t("Reservations")} value={fmt.number(a.summary.reservations)} sub={`${a.summary.bookingsIncludingCancelled} ${t("bookings incl. cancelled")}`} />
            <Stat icon="users" label={t("Covers")} value={fmt.number(a.summary.covers)} sub={a.summary.avgPartySize ? `${a.summary.avgPartySize} ${t("avg party")}` : undefined} />
            <Stat icon="x" label={t("Cancellation rate")} value={a.summary.cancellationRatePct != null ? `${a.summary.cancellationRatePct}%` : "—"} sub={`${a.summary.cancelled} ${t("cancelled")}`} />
            <Stat icon="ban" label={t("No-show rate")} value={a.summary.noShowRatePct != null ? `${a.summary.noShowRatePct}%` : "—"} sub={`${a.summary.noShows} ${t("no-shows")}`} />
            <Stat icon="clock" label={t("Avg seating duration")} value={a.seating.avgDurationMin != null ? `${a.seating.avgDurationMin} min` : "—"} sub={`${t("measured on")} ${a.seating.visitsMeasured} ${t("visits")}`} />
            <Stat icon="table" label={t("Table utilization")} value={a.utilization.tableUtilizationPct != null ? `${a.utilization.tableUtilizationPct}%` : "—"} sub={t("calculated")} />
            <Stat icon="utensils" label={t("Waitlist conversion")} value={a.walkIns.conversionPct != null ? `${a.walkIns.conversionPct}%` : "—"} sub={`${a.walkIns.seated}/${a.walkIns.waitlistEntries} ${t("seated")}`} />
            <Stat icon="refresh" label={t("Returning guests")} value={a.guests.returningPct != null ? `${a.guests.returningPct}%` : "—"} sub={`${a.guests.returningVisits} ${t("returning")} · ${a.guests.firstTimeVisits} ${t("first-time")}`} />
          </section>

          <Card>
            <CardHeader title={t("Revenue")} action={<Badge tone="ok">{t("Measured")}</Badge>} subtitle={a.revenue.note} />
            {a.revenue.recorded != null ? <div className="flex flex-wrap gap-8"><div><p className="text-xs text-muted">{t("Recorded revenue")}</p><p className="text-3xl font-semibold tabular">{money(a.revenue.recorded)}</p></div><div><p className="text-xs text-muted">{t("Avg spend per guest")}</p><p className="text-3xl font-semibold tabular">{a.revenue.avgSpendPerGuest != null ? money(a.revenue.avgSpendPerGuest) : "—"}</p></div><div className="min-w-48"><p className="text-xs text-muted mb-1">{t("Spend coverage")}: {a.revenue.visitsWithSpend}/{a.revenue.visits} {t("visits")}</p><Meter value={a.revenue.visitsWithSpend} max={Math.max(1, a.revenue.visits)} tone={a.revenue.visitsWithSpend < a.revenue.visits ? "gold" : "ok"} label="coverage" /></div></div>
              : <p className="text-sm text-muted">{t("No spend has been recorded in this period. Enter the total when completing a visit, or connect a POS, to see revenue. Nothing is estimated.")}</p>}
          </Card>

          <div className="grid lg:grid-cols-2 gap-6">
            <Card><CardHeader title={t("Reservation volume")} subtitle={t("Per day, excluding cancellations and no-shows")} />
              {a.daily.length > 1 ? <LineChart labels={a.daily.map((d: { date: string }) => d.date.slice(5))} series={[{ name: t("Covers"), values: a.daily.map((d: { covers: number }) => d.covers), color: "#a8803f" }, { name: t("Reservations"), values: a.daily.map((d: { reservations: number }) => d.reservations), color: "#3c6e8f" }]} /> : <p className="text-sm text-muted py-8 text-center">{t("Not enough data.")}</p>}</Card>
            <Card><CardHeader title={t("Covers by hour of arrival")} />{a.byHour.length ? <BarChart data={a.byHour.map((h: { hour: number; covers: number; reservations: number }) => ({ label: `${h.hour}h`, value: h.covers, sub: `${h.reservations} res.` }))} /> : <p className="text-sm text-muted py-8 text-center">{t("No data.")}</p>}</Card>
            <Card><CardHeader title={t("Covers by weekday")} />{a.byWeekday.length ? <BarChart data={a.byWeekday.map((d: { weekday: number; covers: number; reservations: number }) => ({ label: wd(d.weekday), value: d.covers, sub: `${d.reservations} res.` }))} color="#3c6e8f" /> : <p className="text-sm text-muted py-8 text-center">{t("No data.")}</p>}</Card>
            <Card><CardHeader title={t("Covers by service")} />{a.byService.length ? <HBar rows={a.byService.map((s: { service: string; covers: number; reservations: number }) => ({ label: s.service, value: s.covers, sub: `${s.reservations} res.` }))} /> : <p className="text-sm text-muted py-8 text-center">{t("No data.")}</p>}</Card>
          </div>

          <Card pad={false}>
            <div className="p-5 pb-3"><CardHeader title={t("Booking sources")} subtitle={t("Where reservations come from, and how reliable each source is")} /></div>
            <TableWrap><thead><tr><Th>{t("Source")}</Th><Th className="text-end">{t("Bookings")}</Th><Th className="text-end">{t("Covers")}</Th><Th className="text-end">{t("Cancelled")}</Th><Th className="text-end">{t("No-show rate")}</Th></tr></thead>
              <tbody>{a.bySource.map((s: any) => <tr key={s.source}><Td className="font-medium">{t(SOURCE_LABEL[s.source] ?? s.source)}</Td><Td className="text-end tabular">{s.reservations}</Td><Td className="text-end tabular">{s.covers}</Td><Td className="text-end tabular">{s.cancelled}</Td><Td className="text-end tabular">{s.noShowRatePct != null ? `${s.noShowRatePct}%` : "—"}</Td></tr>)}</tbody></TableWrap>
          </Card>

          {a.byLocation.length > 1 && (
            <Card pad={false}><div className="p-5 pb-3"><CardHeader title={t("Location comparison")} /></div>
              <TableWrap><thead><tr><Th>{t("Location")}</Th><Th className="text-end">{t("Reservations")}</Th><Th className="text-end">{t("Covers")}</Th><Th className="text-end">{t("Cancellation rate")}</Th><Th className="text-end">{t("No-show rate")}</Th></tr></thead>
                <tbody>{a.byLocation.map((l: any) => <tr key={l.id}><Td className="font-medium">{l.name}</Td><Td className="text-end tabular">{l.reservations}</Td><Td className="text-end tabular">{l.covers}</Td><Td className="text-end tabular">{l.cancellationRatePct ?? "—"}{l.cancellationRatePct != null && "%"}</Td><Td className="text-end tabular">{l.noShowRatePct ?? "—"}{l.noShowRatePct != null && "%"}</Td></tr>)}</tbody></TableWrap></Card>
          )}

          {a.campaigns.length > 0 && (
            <Card pad={false}><div className="p-5 pb-3"><CardHeader title={t("Marketing campaigns in this period")} subtitle={t("Delivery, engagement and bookings are separate measures")} /></div>
              <TableWrap><thead><tr><Th>{t("Campaign")}</Th><Th className="text-end">{t("Messages")}</Th><Th className="text-end">{t("Delivered")}</Th><Th className="text-end">{t("Simulated")}</Th><Th className="text-end">{t("Opened")}</Th><Th className="text-end">{t("Attributed bookings")}</Th></tr></thead>
                <tbody>{a.campaigns.map((c: any) => <tr key={c.id}><Td className="font-medium">{c.name}</Td><Td className="text-end tabular">{c.messages}</Td><Td className="text-end tabular">{c.delivered}</Td><Td className="text-end tabular">{c.simulated}</Td><Td className="text-end tabular">{c.opened}</Td><Td className="text-end tabular">{c.attributedBookings}</Td></tr>)}</tbody></TableWrap></Card>
          )}

          {hasFeature("forecasting") ? (
            fc.data?.available && fc.data.days?.length ? (
              <Card><CardHeader title={t("Next 14 days — covers forecast")} action={<Badge tone="warn">{t("Estimate")}</Badge>} subtitle={fc.data.method} />
                <BarChart data={fc.data.days.map((d: { date: string; booked: number; forecast: number | null }) => ({ label: d.date.slice(5), value: d.forecast ?? d.booked, sub: `${d.booked} ${t("booked")}` }))} color="#6b5190" /></Card>
            ) : null
          ) : <Notice tone="gold">{t("Forecasting is available on the Enterprise plan.")}</Notice>}
          {a.summary.reservations === 0 && <Card><EmptyState icon="chart" title={t("No reservations in this period")} /></Card>}
        </div>
      )}
    </>
  );
}
