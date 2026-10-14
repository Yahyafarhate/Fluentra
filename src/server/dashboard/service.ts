import type { Db } from "@/lib/db";
import type { Ctx } from "@/lib/auth";
import { assertLocationAccess } from "@/lib/auth";
import { addDays, todayIn } from "@/lib/time";
import { getFloorState } from "../floor/service";
import { listWaitlist } from "../waitlist/service";

export interface DashboardQuery { locationId?: string; date?: string; from?: string; to?: string; serviceId?: string }

/**
 * Metric definitions (also in docs/METRICS.md):
 *  - reservations: bookings in non-draft states (cancelled/no-show are counted separately, not in "active")
 *  - covers: sum of party sizes of reservations that are pending/confirmed/arrived/seated/completed
 *  - revenue/avg spend: ONLY from visits with a recorded spend; coverage shows how many visits have spend data
 */
export async function getDashboard(db: Db, ctx: Ctx, q: DashboardQuery) {
  if (q.locationId) assertLocationAccess(ctx, q.locationId);
  const locs = await db.query<{ id: string; name: string; timezone: string; currency: string }>(
    `SELECT id, name, timezone, currency FROM locations WHERE org_id=$1 AND status='active' AND ($2::uuid IS NULL OR id=$2) AND ($3::uuid[] IS NULL OR id = ANY($3)) ORDER BY name`,
    [ctx.orgId, q.locationId ?? null, ctx.locationIds]);
  if (!locs.length) return { empty: true as const, locations: [] };
  const tz = locs[0].timezone;
  const today = todayIn(tz);
  const from = q.from ?? q.date ?? today;
  const to = q.to ?? q.date ?? from;
  const ids = locs.map((l) => l.id);
  const svc = q.serviceId ?? null;

  const base = `FROM reservations r WHERE r.org_id=$1 AND r.location_id = ANY($2) AND r.service_date BETWEEN $3 AND $4 AND ($5::uuid IS NULL OR r.service_id=$5)`;
  const p = [ctx.orgId, ids, from, to, svc];
  const totals = await db.one<{
    reservations: number; covers: number; pending: number; confirmed: number; arrived: number; seated: number; completed: number; cancelled: number; noShow: number;
    walkIns: number; walkInCovers: number; expectedRemainingCovers: number; vipCount: number;
  }>(
    `SELECT count(*) FILTER (WHERE status NOT IN ('cancelled','no_show'))::int AS reservations,
            COALESCE(sum(party_size) FILTER (WHERE status NOT IN ('cancelled','no_show')),0)::int AS covers,
            count(*) FILTER (WHERE status='pending')::int AS pending, count(*) FILTER (WHERE status='confirmed')::int AS confirmed,
            count(*) FILTER (WHERE status='arrived')::int AS arrived, count(*) FILTER (WHERE status='seated')::int AS seated,
            count(*) FILTER (WHERE status='completed')::int AS completed, count(*) FILTER (WHERE status='cancelled')::int AS cancelled,
            count(*) FILTER (WHERE status='no_show')::int AS no_show,
            count(*) FILTER (WHERE source='walk_in' AND status NOT IN ('cancelled','no_show'))::int AS walk_ins,
            COALESCE(sum(party_size) FILTER (WHERE source='walk_in' AND status NOT IN ('cancelled','no_show')),0)::int AS walk_in_covers,
            COALESCE(sum(party_size) FILTER (WHERE status IN ('pending','confirmed')),0)::int AS expected_remaining_covers,
            count(*) FILTER (WHERE is_vip AND status NOT IN ('cancelled','no_show'))::int AS vip_count
       ${base}`, p);

  const money = await db.one<{ visits: number; withSpend: number; revenue: number | null; spendGuests: number | null }>(
    `SELECT count(*)::int AS visits, count(spend_amount)::int AS with_spend, sum(spend_amount) AS revenue, sum(party_size) FILTER (WHERE spend_amount IS NOT NULL)::int AS spend_guests
       FROM visits v WHERE v.org_id=$1 AND v.location_id = ANY($2) AND (v.seated_at AT TIME ZONE (SELECT timezone FROM locations WHERE id=v.location_id))::date BETWEEN $3 AND $4`, [ctx.orgId, ids, from, to]);

  const upcoming = await db.query(
    `SELECT r.id, r.code, r.guest_name, r.party_size, r.start_at, r.status, r.is_vip, r.special_requests, r.occasion, l.name AS location_name,
            COALESCE((SELECT string_agg(t.name, ' + ' ORDER BY t.name) FROM reservation_tables rt JOIN tables t ON t.id=rt.table_id WHERE rt.reservation_id=r.id), NULL) AS table_names
       FROM reservations r JOIN locations l ON l.id=r.location_id
      WHERE r.org_id=$1 AND r.location_id = ANY($2) AND r.service_date BETWEEN $3 AND $4 AND r.status IN ('pending','confirmed','arrived') AND ($5::uuid IS NULL OR r.service_id=$5)
      ORDER BY r.start_at LIMIT 12`, [ctx.orgId, ids, from, to, svc]);

  const vips = await db.query(
    `SELECT r.id, r.guest_name, r.party_size, r.start_at, r.status, r.special_requests, r.occasion, c.allergies, c.dietary
       FROM reservations r LEFT JOIN customers c ON c.id=r.customer_id
      WHERE r.org_id=$1 AND r.location_id = ANY($2) AND r.service_date BETWEEN $3 AND $4 AND r.status NOT IN ('cancelled','no_show','completed')
        AND ($5::uuid IS NULL OR r.service_id=$5)
        AND (r.is_vip OR r.special_requests IS NOT NULL OR r.occasion IS NOT NULL OR cardinality(c.allergies) > 0)
      ORDER BY r.is_vip DESC, r.start_at LIMIT 12`, [ctx.orgId, ids, from, to, svc]);

  const byHour = await db.query<{ hour: number; covers: number; reservations: number }>(
    `SELECT extract(hour FROM r.start_at AT TIME ZONE l.timezone)::int AS hour, sum(r.party_size)::int AS covers, count(*)::int AS reservations
       FROM reservations r JOIN locations l ON l.id=r.location_id
      WHERE r.org_id=$1 AND r.location_id = ANY($2) AND r.service_date BETWEEN $3 AND $4 AND r.status NOT IN ('cancelled','no_show') AND ($5::uuid IS NULL OR r.service_id=$5)
      GROUP BY 1 ORDER BY 1`, [ctx.orgId, ids, from, to, svc]);

  const trendFrom = addDays(to, -13);
  const trend = await db.query<{ date: string; reservations: number; covers: number; cancelled: number; noShow: number }>(
    `SELECT d::date::text AS date, COALESCE(x.reservations,0)::int AS reservations, COALESCE(x.covers,0)::int AS covers, COALESCE(x.cancelled,0)::int AS cancelled, COALESCE(x.no_show,0)::int AS no_show
       FROM generate_series($3::date, $4::date, interval '1 day') d
       LEFT JOIN (SELECT service_date, count(*) FILTER (WHERE status NOT IN ('cancelled','no_show')) AS reservations,
                         sum(party_size) FILTER (WHERE status NOT IN ('cancelled','no_show')) AS covers,
                         count(*) FILTER (WHERE status='cancelled') AS cancelled, count(*) FILTER (WHERE status='no_show') AS no_show
                    FROM reservations WHERE org_id=$1 AND location_id = ANY($2) AND service_date BETWEEN $3 AND $4 GROUP BY service_date) x ON x.service_date = d::date
      ORDER BY d`, [ctx.orgId, ids, trendFrom, to]);

  const services = await db.query(
    `SELECT COALESCE(s.name, 'Other / special hours') AS service, count(*)::int AS reservations, COALESCE(sum(r.party_size),0)::int AS covers
       FROM reservations r LEFT JOIN services s ON s.id=r.service_id
      WHERE r.org_id=$1 AND r.location_id = ANY($2) AND r.service_date BETWEEN $3 AND $4 AND r.status NOT IN ('cancelled','no_show') GROUP BY 1 ORDER BY covers DESC`, [ctx.orgId, ids, from, to]);

  const availableServices = await db.query(`SELECT DISTINCT ON (name) id, name FROM services WHERE org_id=$1 AND location_id = ANY($2) AND active ORDER BY name`, [ctx.orgId, ids]);

  // live operational state only makes sense when "today" is in range and a single location is selected
  let occupancy: null | { tables: number; seats: number; occupied: number; reserved: number; cleaning: number; blocked: number; available: number; seatedGuests: number } = null;
  let waitlist: null | { waiting: number; notified: number; avgWaitMin: number | null; conversionPct: number | null } = null;
  const includesToday = from <= today && today <= to;
  if (includesToday) {
    const states = await Promise.all(locs.map((l) => getFloorState(db, ctx, l.id)));
    const t = states.flatMap((s) => s.tables);
    occupancy = {
      tables: t.length, seats: t.reduce((n, x) => n + x.capacity, 0),
      occupied: t.filter((x) => x.displayStatus === "occupied").length, reserved: t.filter((x) => x.displayStatus === "reserved").length,
      cleaning: t.filter((x) => x.displayStatus === "cleaning").length, blocked: t.filter((x) => x.displayStatus === "blocked").length,
      available: t.filter((x) => x.displayStatus === "available").length,
      seatedGuests: t.filter((x) => x.current).reduce((n, x) => n + (x.current?.partySize ?? 0), 0),
    };
    const wl = await Promise.all(locs.map((l) => listWaitlist(db, ctx, l.id)));
    const entries = wl.flatMap((w) => w.entries);
    waitlist = {
      waiting: entries.filter((e) => e.status === "waiting").length, notified: entries.filter((e) => e.status === "notified").length,
      avgWaitMin: wl[0]?.stats.avgWaitMin ?? null, conversionPct: wl[0]?.stats.conversionPct ?? null,
    };
  }

  return {
    empty: false as const, locations: locs, range: { from, to, today }, timezone: tz,
    totals, arrivals: totals.arrived + totals.seated + totals.completed,
    revenue: {
      recorded: money.revenue, currency: locs[0].currency,
      avgSpendPerGuest: money.revenue != null && money.spendGuests ? Math.round((money.revenue / money.spendGuests) * 100) / 100 : null,
      visitsWithSpend: money.withSpend, visits: money.visits,
      note: money.withSpend === 0 ? "No spend has been recorded for this period. Revenue is only shown from spend entered per visit (or a connected POS)." : money.withSpend < money.visits ? `Based on ${money.withSpend} of ${money.visits} visits with recorded spend.` : null,
    },
    upcoming, vips, byHour, trend, services, availableServices, occupancy, waitlist,
    generatedAt: new Date(),
  };
}
