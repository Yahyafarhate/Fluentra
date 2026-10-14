import type { Db } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { isoWeekday, minToTime, daysBetween } from "@/lib/time";
import { noonOffsetMin, todayLocal } from "@/lib/tz";
import {
  durationFor, pickTables, resolveWindows, slotTimes,
  type BusyInterval, type ComboLite, type DurationRule, type ServiceRow, type SpecialDayRow, type TableLite, type ServiceWindow,
} from "./engine";

export interface LocationRow {
  id: string; orgId: string; name: string; slug: string; status: string; timezone: string;
  address: string | null; city: string | null; phone: string | null; email: string | null; website: string | null;
  description: string | null; logoUrl: string | null; coverUrl: string | null; gallery: string[]; brandColor: string; currency: string; defaultLocale: string;
  slotIntervalMin: number; bufferMin: number; durationRules: DurationRule[]; minParty: number; maxPartyOnline: number; maxParty: number;
  bookingWindowDays: number; minNoticeMin: number; cancelDeadlineHours: number; autoConfirm: boolean; onlineBookingEnabled: boolean;
  maxCoversPerSlot: number | null; waitlistEnabled: boolean; publicWaitlistEnabled: boolean; depositEnabled: boolean;
  depositAmountPerGuest: number; depositMinParty: number; cleaningWorkflow: boolean; noShowGraceMin: number; holdMinutes: number;
  policyText: string | null; waitlistPriority: Record<string, number>;
}

export async function loadLocation(db: Db, locationId: string): Promise<LocationRow> {
  const loc = await db.maybe<LocationRow>(`SELECT * FROM locations WHERE id = $1 AND status = 'active'`, [locationId]);
  if (!loc) throw notFound("Location");
  return loc;
}

/** Serializes all booking mutations of a location for the duration of the transaction. */
export async function lockLocation(db: Db, locationId: string) {
  await db.exec(`SELECT pg_advisory_xact_lock(hashtextextended('loc:' || $1::text, 0))`, [locationId]);
}

export interface DayData {
  loc: LocationRow;
  windows: ServiceWindow[];
  closed: boolean;
  closedLabel: string | null;
  tables: TableLite[];
  combos: ComboLite[];
  busy: BusyInterval[];
  reservations: Array<{ id: string; startAt: Date; partySize: number; serviceId: string | null }>;
  /** local wall-clock minute-of-day -> UTC instant for this date (offset resolved by the database) */
  utcAt: (minuteOfDay: number) => Date;
  today: string;
}

export async function loadTables(db: Db, locationId: string): Promise<{ tables: TableLite[]; combos: ComboLite[] }> {
  const tables = await db.query<TableLite>(
    `SELECT id, name, min_capacity, capacity, section_id, floor_id, bookable_online, status, active FROM tables WHERE location_id = $1 AND active`, [locationId]);
  const combos = await db.query<ComboLite>(
    `SELECT c.id, c.name, c.min_capacity, c.capacity, array_agg(ct.table_id) AS table_ids
       FROM table_combinations c JOIN table_combination_tables ct ON ct.combination_id = c.id
      WHERE c.location_id = $1 AND c.active GROUP BY c.id`, [locationId]);
  return { tables, combos };
}

export async function loadBusy(db: Db, locationId: string, from: Date, to: Date, opts: { excludeReservationId?: string; excludeHoldToken?: string; now?: Date } = {}): Promise<BusyInterval[]> {
  const now = opts.now ?? new Date();
  const rows = await db.query<{ tableId: string; s: Date; e: Date; status: string }>(
    `SELECT rt.table_id, lower(rt.during) AS s, upper(rt.during) AS e, r.status
       FROM reservation_tables rt JOIN reservations r ON r.id = rt.reservation_id
      WHERE rt.location_id = $1 AND rt.during && tstzrange($2, $3) AND ($4::uuid IS NULL OR rt.reservation_id <> $4)`,
    [locationId, from, to, opts.excludeReservationId ?? null]);
  const busy: BusyInterval[] = rows.map((r) => {
    let end = r.e.getTime();
    // a seated party that overstays keeps the table occupied beyond its planned end
    if (r.status === "seated" && end < now.getTime() + 15 * 60_000) end = now.getTime() + 15 * 60_000;
    return { tableId: r.tableId, start: r.s.getTime(), end };
  });
  const holds = await db.query<{ tableIds: string[]; s: Date; e: Date }>(
    `SELECT table_ids, lower(during) AS s, upper(during) AS e FROM slot_holds
      WHERE location_id = $1 AND expires_at > now() AND during && tstzrange($2, $3)
        AND ($4::text IS NULL OR token_hash <> $4)`,
    [locationId, from, to, opts.excludeHoldToken ?? null]);
  for (const h of holds) for (const id of h.tableIds) busy.push({ tableId: id, start: h.s.getTime(), end: h.e.getTime() });
  return busy;
}

export async function loadDay(db: Db, loc: LocationRow, date: string, opts: { excludeReservationId?: string; excludeHoldToken?: string; now?: Date } = {}): Promise<DayData> {
  const services = await db.query<ServiceRow>(
    `SELECT id, name, days, to_char(start_time,'HH24:MI') AS start_time, to_char(last_seating,'HH24:MI') AS last_seating, slot_interval_min, max_covers, active
       FROM services WHERE location_id = $1`, [loc.id]);
  const special = await db.maybe<SpecialDayRow>(
    `SELECT closed, label, to_char(start_time,'HH24:MI') AS start_time, to_char(last_seating,'HH24:MI') AS last_seating FROM special_days WHERE location_id=$1 AND date=$2`, [loc.id, date]);
  const res = resolveWindows(services, isoWeekday(date), loc.slotIntervalMin, special);
  const { tables, combos } = await loadTables(db, loc.id);
  const offsetMin = await noonOffsetMin(db, date, loc.timezone);
  const [y, m, d] = date.split("-").map(Number);
  const midnight = Date.UTC(y, m - 1, d);
  const utcAt = (min: number) => new Date(midnight + (min - offsetMin) * 60_000);
  const busy = await loadBusy(db, loc.id, new Date(utcAt(0).getTime() - 12 * 3600_000), new Date(utcAt(1440).getTime() + 12 * 3600_000), opts);
  const reservations = await db.query<{ id: string; startAt: Date; partySize: number; serviceId: string | null }>(
    `SELECT id, start_at, party_size, service_id FROM reservations
      WHERE location_id = $1 AND service_date = $2 AND status IN ('pending','confirmed','arrived','seated','completed')
        AND ($3::uuid IS NULL OR id <> $3)`, [loc.id, date, opts.excludeReservationId ?? null]);
  const today = await todayLocal(db, loc.timezone, opts.now);
  return { loc, windows: res.windows, closed: res.closed, closedLabel: res.label, tables, combos, busy, reservations, utcAt, today };
}

export type SlotReason = "past" | "notice" | "window" | "party_small" | "party_large" | "pacing" | "service_cap" | "full" | "closed";

export interface Slot {
  time: string; startAt: string; endAt: string; serviceId: string | null; serviceName: string;
  available: boolean; reason?: SlotReason; durationMin: number; tableIds?: string[];
}

export interface SlotQuery {
  channel: "online" | "staff";
  partySize: number;
  now?: Date;
  preferSectionId?: string | null;
  sectionId?: string | null;
}

/** Evaluates one candidate start against every booking rule. Used by both slot listing and reservation creation. */
export function evaluateStart(day: DayData, date: string, startMin: number, w: ServiceWindow | null, q: SlotQuery): Slot {
  const { loc } = day;
  const now = q.now ?? new Date();
  const startAt = day.utcAt(startMin);
  const durationMin = durationFor(loc.durationRules, q.partySize);
  const end = new Date(startAt.getTime() + durationMin * 60_000);
  const base: Slot = {
    time: minToTime(startMin % 1440), startAt: startAt.toISOString(), endAt: end.toISOString(),
    serviceId: w?.serviceId ?? null, serviceName: w?.name ?? "", available: false, durationMin,
  };
  const fail = (reason: SlotReason): Slot => ({ ...base, available: false, reason });

  if (!w) return fail("closed");
  if (q.channel === "online") {
    if (q.partySize < loc.minParty) return fail("party_small");
    if (q.partySize > loc.maxPartyOnline) return fail("party_large");
    if (startAt.getTime() < now.getTime() + loc.minNoticeMin * 60_000) return fail("notice");
    if (daysBetween(day.today, date) > loc.bookingWindowDays) return fail("window");
  } else {
    if (q.partySize > loc.maxParty) return fail("party_large");
    if (startAt.getTime() < now.getTime() - 3 * 3600_000) return fail("past");
  }
  if (loc.maxCoversPerSlot != null) {
    const covers = day.reservations.filter((r) => r.startAt.getTime() === startAt.getTime()).reduce((n, r) => n + r.partySize, 0);
    if (covers + q.partySize > loc.maxCoversPerSlot) return fail("pacing");
  }
  if (w.maxCovers != null && w.serviceId) {
    const covers = day.reservations.filter((r) => r.serviceId === w.serviceId).reduce((n, r) => n + r.partySize, 0);
    if (covers + q.partySize > w.maxCovers) return fail("service_cap");
  }
  const tableIds = pickTables({
    tables: day.tables, combos: day.combos, busy: day.busy,
    start: startAt.getTime(), end: end.getTime() + loc.bufferMin * 60_000, party: q.partySize,
    onlineOnly: q.channel === "online", preferSectionId: q.preferSectionId, onlySectionId: q.sectionId,
  });
  if (!tableIds) return fail("full");
  return { ...base, available: true, tableIds };
}

export async function computeSlots(db: Db, loc: LocationRow, date: string, q: SlotQuery & { excludeReservationId?: string; excludeHoldToken?: string }) {
  const day = await loadDay(db, loc, date, q);
  if (day.closed) return { date, closed: true, closedLabel: day.closedLabel, slots: [] as Slot[] };
  const slots: Slot[] = [];
  for (const w of day.windows) for (const m of slotTimes(w)) slots.push(evaluateStart(day, date, m, w, q));
  return { date, closed: false, closedLabel: null, slots };
}

/** Which service window contains a given local start time (null = outside service hours). */
export function windowFor(day: DayData, startMin: number): ServiceWindow | null {
  return day.windows.find((w) => startMin >= w.startMin && startMin <= w.lastSeatingMin) ?? null;
}
