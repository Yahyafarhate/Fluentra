import { z } from "zod";
import type { Db } from "@/lib/db";
import { assertLocationAccess, type Ctx } from "@/lib/auth";
import { addDays, daysBetween, isDateStr, todayIn, isoWeekday } from "@/lib/time";
import { hasFeature } from "../billing/limits";
import { badRequest } from "@/lib/errors";

export const analyticsQuerySchema = z.object({
  from: z.string().refine(isDateStr), to: z.string().refine(isDateStr),
  locationId: z.string().uuid().optional(),
});
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

/** Pure helpers (unit-tested) */
export const pct = (num: number, den: number): number | null => (den > 0 ? Math.round((1000 * num) / den) / 10 : null);

export function forecastCovers(history: Array<{ date: string; covers: number }>, targetDate: string, weeks = 8): { covers: number; samples: number } | null {
  const wd = isoWeekday(targetDate);
  const same = history.filter((h) => isoWeekday(h.date) === wd && h.date < targetDate && daysBetween(h.date, targetDate) <= weeks * 7);
  if (same.length < 3) return null;
  return { covers: Math.round(same.reduce((n, h) => n + h.covers, 0) / same.length), samples: same.length };
}

export async function getAnalytics(db: Db, ctx: Ctx, q: AnalyticsQuery) {
  if (daysBetween(q.from, q.to) < 0) throw badRequest("'from' must not be after 'to'", "INVALID_RANGE");
  if (daysBetween(q.from, q.to) > 400) throw badRequest("Date range is limited to 400 days", "RANGE_TOO_LARGE");
  if (q.locationId) assertLocationAccess(ctx, q.locationId);
  const locs = await db.query<{ id: string; name: string; timezone: string; currency: string }>(
    `SELECT id, name, timezone, currency FROM locations WHERE org_id=$1 AND ($2::uuid IS NULL OR id=$2) AND ($3::uuid[] IS NULL OR id = ANY($3)) ORDER BY name`, [ctx.orgId, q.locationId ?? null, ctx.locationIds]);
  const ids = locs.map((l) => l.id);
  const P = [ctx.orgId, ids, q.from, q.to];
  const R = `reservations r JOIN locations l ON l.id=r.location_id WHERE r.org_id=$1 AND r.location_id = ANY($2) AND r.service_date BETWEEN $3 AND $4`;

  const summary = await db.one<{ total: number; active: number; covers: number; cancelled: number; noShow: number; completed: number; due: number; avgParty: number | null }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE r.status NOT IN ('cancelled','no_show'))::int AS active,
            COALESCE(sum(r.party_size) FILTER (WHERE r.status NOT IN ('cancelled','no_show')),0)::int AS covers,
            count(*) FILTER (WHERE r.status='cancelled')::int AS cancelled, count(*) FILTER (WHERE r.status='no_show')::int AS no_show,
            count(*) FILTER (WHERE r.status='completed')::int AS completed,
            count(*) FILTER (WHERE r.status IN ('completed','seated','arrived'))::int AS due,
            round(avg(r.party_size) FILTER (WHERE r.status NOT IN ('cancelled','no_show')),1) AS avg_party
       FROM ${R}`, P);

  const daily = await db.query<{ date: string; reservations: number; covers: number; cancelled: number; noShow: number; walkIns: number }>(
    `SELECT r.service_date::text AS date, count(*) FILTER (WHERE r.status NOT IN ('cancelled','no_show'))::int AS reservations,
            COALESCE(sum(r.party_size) FILTER (WHERE r.status NOT IN ('cancelled','no_show')),0)::int AS covers,
            count(*) FILTER (WHERE r.status='cancelled')::int AS cancelled, count(*) FILTER (WHERE r.status='no_show')::int AS no_show,
            count(*) FILTER (WHERE r.source='walk_in')::int AS walk_ins
       FROM ${R} GROUP BY 1 ORDER BY 1`, P);

  const byService = await db.query(
    `SELECT COALESCE(s.name,'Other / special hours') AS service, count(*)::int AS reservations, COALESCE(sum(r.party_size),0)::int AS covers
       FROM reservations r LEFT JOIN services s ON s.id=r.service_id
      WHERE r.org_id=$1 AND r.location_id = ANY($2) AND r.service_date BETWEEN $3 AND $4 AND r.status NOT IN ('cancelled','no_show') GROUP BY 1 ORDER BY covers DESC`, P);

  const byWeekday = await db.query<{ weekday: number; reservations: number; covers: number }>(
    `SELECT extract(isodow FROM r.service_date)::int AS weekday, count(*)::int AS reservations, COALESCE(sum(r.party_size),0)::int AS covers
       FROM ${R} AND r.status NOT IN ('cancelled','no_show') GROUP BY 1 ORDER BY 1`, P);

  const byHour = await db.query<{ hour: number; reservations: number; covers: number }>(
    `SELECT extract(hour FROM r.start_at AT TIME ZONE l.timezone)::int AS hour, count(*)::int AS reservations, COALESCE(sum(r.party_size),0)::int AS covers
       FROM ${R} AND r.status NOT IN ('cancelled','no_show') GROUP BY 1 ORDER BY 1`, P);

  const bySource = await db.query(
    `SELECT r.source, count(*)::int AS reservations, COALESCE(sum(r.party_size) FILTER (WHERE r.status NOT IN ('cancelled','no_show')),0)::int AS covers,
            count(*) FILTER (WHERE r.status='cancelled')::int AS cancelled, count(*) FILTER (WHERE r.status='no_show')::int AS no_show
       FROM ${R} GROUP BY 1 ORDER BY reservations DESC`, P);

  // Actual seating durations come from recorded visits (seated -> left)
  const dur = await db.one<{ avgMin: number | null; visits: number }>(
    `SELECT round(avg(extract(epoch FROM (v.left_at - v.seated_at))/60))::int AS avg_min, count(*)::int AS visits
       FROM visits v JOIN locations l ON l.id=v.location_id
      WHERE v.org_id=$1 AND v.location_id = ANY($2) AND v.left_at IS NOT NULL AND (v.seated_at AT TIME ZONE l.timezone)::date BETWEEN $3 AND $4`, P);

  // Table utilization = occupied table-minutes (completed visits) / (tables x service minutes per open day)
  const util = await db.one<{ occupiedMin: number | null; availableMin: number | null }>(
    `WITH days AS (SELECT l.id AS location_id, d::date AS day, extract(isodow FROM d)::int AS wd FROM locations l, generate_series($3::date, $4::date, interval '1 day') d WHERE l.org_id=$1 AND l.id = ANY($2)),
          open_min AS (SELECT dy.location_id, dy.day,
                         COALESCE(sd_special.mins, sd_regular.mins, 0) AS mins
                       FROM days dy
                       LEFT JOIN (SELECT location_id, date, CASE WHEN closed THEN 0 ELSE extract(epoch FROM (last_seating - start_time))/60 END AS mins FROM special_days) sd_special ON sd_special.location_id=dy.location_id AND sd_special.date=dy.day
                       LEFT JOIN (SELECT location_id, wd, sum(m) AS mins FROM (SELECT location_id, unnest(days) AS wd, extract(epoch FROM (last_seating - start_time))/60 AS m FROM services WHERE active) z GROUP BY 1,2) sd_regular ON sd_regular.location_id=dy.location_id AND sd_regular.wd=dy.wd),
          tcount AS (SELECT location_id, count(*) AS n FROM tables WHERE active GROUP BY 1)
     SELECT (SELECT sum(extract(epoch FROM (v.left_at - v.seated_at))/60 * GREATEST(cardinality(v.table_ids),1)) FROM visits v JOIN locations l ON l.id=v.location_id
              WHERE v.org_id=$1 AND v.location_id = ANY($2) AND v.left_at IS NOT NULL AND (v.seated_at AT TIME ZONE l.timezone)::date BETWEEN $3 AND $4) AS occupied_min,
            (SELECT sum(om.mins * COALESCE(tc.n,0)) FROM open_min om LEFT JOIN tcount tc ON tc.location_id=om.location_id) AS available_min`, P);

  const walkins = await db.one<{ entries: number; seated: number }>(
    `SELECT count(*)::int AS entries, count(*) FILTER (WHERE w.status='seated')::int AS seated
       FROM waitlist_entries w JOIN locations l ON l.id=w.location_id
      WHERE w.org_id=$1 AND w.location_id = ANY($2) AND (w.joined_at AT TIME ZONE l.timezone)::date BETWEEN $3 AND $4`, P);

  const guests = await db.one<{ firstTime: number; returning: number }>(
    `WITH v AS (SELECT v.customer_id, v.seated_at, v.org_id FROM visits v JOIN locations l ON l.id=v.location_id
                 WHERE v.org_id=$1 AND v.location_id = ANY($2) AND v.customer_id IS NOT NULL AND (v.seated_at AT TIME ZONE l.timezone)::date BETWEEN $3 AND $4)
     SELECT count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM visits p WHERE p.customer_id=v.customer_id AND p.seated_at < v.seated_at))::int AS first_time,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM visits p WHERE p.customer_id=v.customer_id AND p.seated_at < v.seated_at))::int AS returning
       FROM v`, P);

  const money = await db.one<{ visits: number; withSpend: number; revenue: number | null; guestsWithSpend: number | null }>(
    `SELECT count(*)::int AS visits, count(v.spend_amount)::int AS with_spend, sum(v.spend_amount) AS revenue,
            sum(v.party_size) FILTER (WHERE v.spend_amount IS NOT NULL)::int AS guests_with_spend
       FROM visits v JOIN locations l ON l.id=v.location_id WHERE v.org_id=$1 AND v.location_id = ANY($2) AND (v.seated_at AT TIME ZONE l.timezone)::date BETWEEN $3 AND $4`, P);

  const byLocation = await db.query(
    `SELECT l.id, l.name, count(r.id) FILTER (WHERE r.status NOT IN ('cancelled','no_show'))::int AS reservations,
            COALESCE(sum(r.party_size) FILTER (WHERE r.status NOT IN ('cancelled','no_show')),0)::int AS covers,
            count(r.id) FILTER (WHERE r.status='cancelled')::int AS cancelled, count(r.id) FILTER (WHERE r.status='no_show')::int AS no_show,
            count(r.id) FILTER (WHERE r.status IN ('completed','no_show','seated','arrived'))::int AS due
       FROM locations l LEFT JOIN reservations r ON r.location_id=l.id AND r.service_date BETWEEN $3 AND $4
      WHERE l.org_id=$1 AND l.id = ANY($2) GROUP BY l.id, l.name ORDER BY l.name`, P);

  const campaigns = await db.query(
    `SELECT c.id, c.name, c.channel, c.status, c.sent_at,
            count(n.id)::int AS messages, count(n.id) FILTER (WHERE n.status IN ('sent','delivered'))::int AS sent,
            count(n.id) FILTER (WHERE n.status='delivered')::int AS delivered, count(n.id) FILTER (WHERE n.status='simulated')::int AS simulated,
            count(n.id) FILTER (WHERE n.opened_at IS NOT NULL)::int AS opened, count(n.id) FILTER (WHERE n.clicked_at IS NOT NULL)::int AS clicked,
            (SELECT count(*) FROM reservations r WHERE r.campaign_id=c.id AND r.status NOT IN ('cancelled'))::int AS attributed_bookings
       FROM campaigns c LEFT JOIN notifications n ON n.campaign_id=c.id
      WHERE c.org_id=$1 AND (c.location_id IS NULL OR c.location_id = ANY($2)) AND c.status IN ('sent','sending') AND c.sent_at::date BETWEEN $3 AND $4 GROUP BY c.id ORDER BY c.sent_at DESC`, [ctx.orgId, ids, q.from, q.to]);

  const days = daysBetween(q.from, q.to) + 1;
  return {
    range: { from: q.from, to: q.to, days }, locations: locs.map((l) => ({ id: l.id, name: l.name, timezone: l.timezone })),
    summary: {
      reservations: summary.active, bookingsIncludingCancelled: summary.total, covers: summary.covers, avgPartySize: summary.avgParty,
      cancellationRatePct: pct(summary.cancelled, summary.total), noShowRatePct: pct(summary.noShow, summary.due + summary.noShow),
      completed: summary.completed, cancelled: summary.cancelled, noShows: summary.noShow,
    },
    daily, byService, byWeekday, byHour, bySource: bySource.map((s: Record<string, number | string>) => ({ ...s, noShowRatePct: pct(Number(s.noShow), Number(s.reservations) - Number(s.cancelled)) })),
    seating: { avgDurationMin: dur.avgMin, visitsMeasured: dur.visits },
    utilization: { tableUtilizationPct: util.availableMin ? pct(util.occupiedMin ?? 0, util.availableMin) : null, basis: "occupied table-minutes of completed visits ÷ (tables × scheduled service minutes)" },
    walkIns: { waitlistEntries: walkins.entries, seated: walkins.seated, conversionPct: pct(walkins.seated, walkins.entries) },
    guests: { firstTimeVisits: guests.firstTime, returningVisits: guests.returning, returningPct: pct(guests.returning, guests.firstTime + guests.returning) },
    revenue: {
      recorded: money.revenue, visits: money.visits, visitsWithSpend: money.withSpend,
      avgSpendPerGuest: money.revenue != null && money.guestsWithSpend ? Math.round((money.revenue / money.guestsWithSpend) * 100) / 100 : null,
      measured: true, note: money.withSpend ? `Measured from ${money.withSpend} of ${money.visits} visits with recorded spend.` : "No spend recorded in this period.",
    },
    byLocation: byLocation.map((l: Record<string, number | string>) => ({ ...l, cancellationRatePct: pct(Number(l.cancelled), Number(l.reservations) + Number(l.cancelled)), noShowRatePct: pct(Number(l.noShow), Number(l.due) + 0) })),
    campaigns,
  };
}

export async function getForecast(db: Db, ctx: Ctx, locationId: string | undefined) {
  if (!(await hasFeature(db, ctx.orgId, "forecasting"))) return { available: false as const, reason: "FEATURE_NOT_IN_PLAN" };
  if (locationId) assertLocationAccess(ctx, locationId);
  const locs = await db.query<{ id: string; timezone: string }>(`SELECT id, timezone FROM locations WHERE org_id=$1 AND status='active' AND ($2::uuid IS NULL OR id=$2) AND ($3::uuid[] IS NULL OR id = ANY($3))`, [ctx.orgId, locationId ?? null, ctx.locationIds]);
  if (!locs.length) return { available: true as const, days: [] };
  const today = todayIn(locs[0].timezone);
  const hist = await db.query<{ date: string; covers: number }>(
    `SELECT service_date::text AS date, sum(party_size)::int AS covers FROM reservations
      WHERE org_id=$1 AND location_id = ANY($2) AND service_date BETWEEN $3 AND $4 AND status IN ('completed','seated') GROUP BY 1`, [ctx.orgId, locs.map((l) => l.id), addDays(today, -70), addDays(today, -1)]);
  const booked = await db.query<{ date: string; covers: number }>(
    `SELECT service_date::text AS date, sum(party_size)::int AS covers FROM reservations WHERE org_id=$1 AND location_id = ANY($2) AND service_date BETWEEN $3 AND $4 AND status IN ('pending','confirmed','arrived','seated') GROUP BY 1`,
    [ctx.orgId, locs.map((l) => l.id), today, addDays(today, 13)]);
  const days = [];
  for (let i = 0; i < 14; i++) {
    const date = addDays(today, i);
    const f = forecastCovers(hist, date);
    const b = booked.find((x) => x.date === date)?.covers ?? 0;
    days.push({ date, booked: b, forecast: f ? Math.max(f.covers, b) : null, samples: f?.samples ?? 0 });
  }
  return { available: true as const, estimate: true, method: "Average covers of the same weekday over the previous 8 weeks (completed/seated), never below covers already booked. This is an estimate, not a guarantee.", days };
}

/** CSV with spreadsheet-injection protection. */
export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (!rows.length && !columns) return "";
  const cols = columns ?? Object.keys(rows[0]);
  const cell = (v: unknown) => {
    let s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}

export async function exportReservationsCsv(db: Db, ctx: Ctx, q: AnalyticsQuery): Promise<string> {
  if (q.locationId) assertLocationAccess(ctx, q.locationId);
  const rows = await db.query(
    `SELECT l.name AS location, r.service_date AS date, to_char(r.start_at AT TIME ZONE l.timezone,'HH24:MI') AS time, r.code, r.guest_name AS guest, r.party_size AS party_size,
            r.status, r.source, COALESCE((SELECT string_agg(t.name, '+' ORDER BY t.name) FROM reservation_tables rt JOIN tables t ON t.id=rt.table_id WHERE rt.reservation_id=r.id),'') AS tables,
            r.occasion, r.created_at AS created_at
       FROM reservations r JOIN locations l ON l.id=r.location_id
      WHERE r.org_id=$1 AND ($2::uuid IS NULL OR r.location_id=$2) AND ($5::uuid[] IS NULL OR r.location_id = ANY($5)) AND r.service_date BETWEEN $3 AND $4 ORDER BY r.start_at LIMIT 50000`,
    [ctx.orgId, q.locationId ?? null, q.from, q.to, ctx.locationIds]);
  return toCsv(rows, ["location", "date", "time", "code", "guest", "partySize", "status", "source", "tables", "occasion", "createdAt"]);
}
