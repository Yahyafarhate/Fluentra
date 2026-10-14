import { z } from "zod";
import { withOrg, withSystem, notifyChange, type Db } from "@/lib/db";
import type { Ctx } from "@/lib/auth";
import { assertLocationAccess } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from "@/lib/errors";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { isDateStr, isTimeStr, timeToMin, serviceDateOf, timeOf } from "@/lib/time";
import { randomToken, sha256, shortCode } from "@/lib/ids";
import { evaluateStart, loadDay, loadLocation, lockLocation, windowFor, type DayData, type LocationRow } from "../availability/service";
import { pickTables, validateManualAssignment } from "../availability/engine";
import { resolveCustomer } from "../customers/service";
import { dispatchEvent } from "../automation/service";
import { manageToken, verifyManageToken } from "../notifications/service";
import { assertWithinPlan } from "../billing/limits";
import { canTransition, isActive, TRANSITIONS, type Action, type Status } from "./state";

export const SOURCES = ["online", "phone", "walk_in", "instagram", "whatsapp", "google", "staff", "email", "other"] as const;

export const bookingInputSchema = z.object({
  locationId: z.string().uuid(),
  date: z.string().refine(isDateStr, "Invalid date (YYYY-MM-DD)"),
  time: z.string().refine(isTimeStr, "Invalid time (HH:mm)"),
  partySize: z.number().int().min(1).max(500),
  guestName: z.string().trim().min(1).max(120),
  guestPhone: z.string().trim().max(32).optional().nullable().or(z.literal("")),
  guestEmail: z.string().trim().email().max(200).optional().nullable().or(z.literal("")),
  occasion: z.string().trim().max(60).optional().nullable(),
  specialRequests: z.string().trim().max(1000).optional().nullable(),
  internalNotes: z.string().trim().max(2000).optional().nullable(),
  seatingPreference: z.string().trim().max(200).optional().nullable(),
  source: z.enum(SOURCES).default("staff"),
  isVip: z.boolean().optional(),
  isPrivateEvent: z.boolean().optional(),
  customerId: z.string().uuid().optional().nullable(),
  tableIds: z.array(z.string().uuid()).max(10).optional(),
  status: z.enum(["pending", "confirmed"]).optional(),
  language: z.enum(["fr", "en", "ar"]).optional().nullable(),
  consent: z.object({ email: z.boolean().optional(), sms: z.boolean().optional(), whatsapp: z.boolean().optional() }).optional(),
  allowDuplicate: z.boolean().optional(),
  force: z.boolean().optional(),
});
export type BookingInput = z.infer<typeof bookingInputSchema>;

type Actor = { kind: "staff"; ctx: Ctx } | { kind: "guest" };

export interface BookingOptions {
  orgId: string;
  actor: Actor;
  holdToken?: string;
  campaignId?: string | null;
  offerId?: string | null;
  now?: Date;
  /** internal: create directly in the seated state (walk-ins) */
  seatNow?: boolean;
}

const nullIfEmpty = (v: string | null | undefined) => (v === undefined || v === null || v === "" ? null : v);

function rangeSql(start: Date, end: Date) { return `[${start.toISOString()},${end.toISOString()})`; }

async function generateCode(db: Db): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const code = shortCode(6);
    if (!(await db.maybe(`SELECT 1 FROM reservations WHERE code=$1`, [code]))) return code;
  }
  throw new AppError(500, "CODE_GENERATION", "Could not generate a reservation code");
}

function depositFor(loc: LocationRow, party: number, source: string) {
  if (!loc.depositEnabled || source !== "online" || party < loc.depositMinParty) return { amount: 0, needed: false };
  return { amount: Math.round(loc.depositAmountPerGuest * party * 100) / 100, needed: loc.depositAmountPerGuest > 0 };
}

const RULE_REASON_MSG: Record<string, [string, string]> = {
  closed: ["CLOSED", "The restaurant is closed at that time"],
  past: ["IN_THE_PAST", "That time is in the past"],
  notice: ["TOO_SOON", "Online bookings need more notice for that time"],
  window: ["TOO_FAR", "That date is beyond the booking window"],
  party_small: ["PARTY_TOO_SMALL", "Party size is below the minimum"],
  party_large: ["PARTY_TOO_LARGE", "Party size exceeds the maximum for this channel — please contact the restaurant"],
  pacing: ["PACING_LIMIT", "That time slot is fully booked (cover limit reached)"],
  service_cap: ["SERVICE_CAP", "This service is fully booked"],
  full: ["NO_AVAILABILITY", "No table is available for that party size and time"],
};

/**
 * Creates a reservation and allocates tables atomically.
 * Concurrency: per-location advisory lock serializes writers; the GiST exclusion constraint on reservation_tables is the final guard.
 */
export async function createReservationTx(db: Db, input: BookingInput, o: BookingOptions) {
  const now = o.now ?? new Date();
  const loc = await loadLocation(db, input.locationId);
  if (o.actor.kind === "staff") assertLocationAccess(o.actor.ctx, loc.id);
  else if (!loc.onlineBookingEnabled) throw forbidden("Online booking is not available for this restaurant", "ONLINE_BOOKING_DISABLED");
  const channel = o.actor.kind === "guest" || input.source === "online" ? "online" : "staff";
  if (o.actor.kind === "guest" && input.source !== "online") input = { ...input, source: "online" };
  const force = o.actor.kind === "staff" && !!input.force;

  await assertWithinPlan(db, o.orgId, "reservations");
  await lockLocation(db, loc.id);

  const holdHash = o.holdToken ? sha256(o.holdToken) : undefined;
  const day = await loadDay(db, loc, input.date, { excludeHoldToken: holdHash, now });
  const startMin = timeToMin(input.time);
  const w = windowFor(day, startMin);
  if (!w && !force) throw unprocessable(RULE_REASON_MSG.closed[1], "CLOSED");
  if (channel === "online" && w && (startMin - w.startMin) % w.intervalMin !== 0) throw unprocessable("That start time is not offered", "INVALID_SLOT");

  const slot = evaluateStart(day, input.date, startMin, w, { channel, partySize: input.partySize, now });
  // walk-ins occupy the table from this very moment (not from a rounded slot time)
  const start = o.seatNow ? now : new Date(slot.startAt);
  const end = o.seatNow ? new Date(now.getTime() + slot.durationMin * 60_000) : new Date(slot.endAt);
  const tableEnd = new Date(end.getTime() + loc.bufferMin * 60_000);

  let tableIds: string[] | null = null;
  if (o.seatNow && !input.tableIds?.length) {
    // walk-ins sit at a table that is physically ready right now
    tableIds = pickTables({ tables: day.tables.filter((t) => t.status === "available"), combos: day.combos, busy: day.busy, start: start.getTime(), end: tableEnd.getTime(), party: input.partySize });
    if (!tableIds) throw conflict(RULE_REASON_MSG.full[1], "NO_AVAILABILITY");
  } else if (input.tableIds?.length) {
    if (o.actor.kind !== "staff") throw forbidden("Guests cannot choose tables", "FORBIDDEN");
    const err = validateManualAssignment({ tables: day.tables, combos: day.combos, busy: day.busy, tableIds: input.tableIds, start: start.getTime(), end: tableEnd.getTime(), party: input.partySize });
    if (err) throw conflict(`Cannot assign the selected table(s): ${err}`, err);
    tableIds = input.tableIds;
    if (!slot.available && slot.reason !== "full" && !force) { const [c, m] = RULE_REASON_MSG[slot.reason ?? "full"]; throw unprocessable(m, c); }
  } else if (slot.available) {
    tableIds = slot.tableIds!;
  } else if (force && slot.reason !== "full") {
    tableIds = pickTables({ tables: day.tables, combos: day.combos, busy: day.busy, start: start.getTime(), end: tableEnd.getTime(), party: input.partySize });
    if (!tableIds) throw conflict(RULE_REASON_MSG.full[1], "NO_AVAILABILITY");
  } else {
    const [c, m] = RULE_REASON_MSG[slot.reason ?? "full"];
    throw (c === "NO_AVAILABILITY" ? conflict(m, c) : unprocessable(m, c));
  }

  const phone = normalizePhone(nullIfEmpty(input.guestPhone));
  if (nullIfEmpty(input.guestPhone) && !phone) throw badRequest("Invalid phone number", "INVALID_PHONE");
  const email = normalizeEmail(nullIfEmpty(input.guestEmail));
  if (channel === "online" && !phone && !email) throw badRequest("A phone number or email is required", "CONTACT_REQUIRED");

  if (!input.allowDuplicate && (phone || email)) {
    const dup = await db.maybe<{ id: string; code: string }>(
      `SELECT id, code FROM reservations WHERE location_id=$1 AND service_date=$2 AND status IN ('pending','confirmed','arrived','seated')
          AND ((guest_phone IS NOT NULL AND guest_phone=$3) OR (guest_email IS NOT NULL AND guest_email=$4))
          AND start_at < $6 AND end_at > $5 LIMIT 1`, [loc.id, input.date, phone, email, start, end]);
    if (dup) throw conflict("This guest already has an overlapping reservation at that time", "DUPLICATE_RESERVATION", { code: dup.code });
  }

  let customerId = input.customerId ?? null;
  if (customerId) {
    const ok = await db.maybe(`SELECT 1 FROM customers WHERE id=$1 AND org_id=$2 AND merged_into IS NULL`, [customerId, o.orgId]);
    if (!ok) throw notFound("Customer");
  } else {
    customerId = (await resolveCustomer(db, o.orgId, {
      name: input.guestName, phone, email, language: input.language ?? null, source: channel === "online" ? "online" : input.source,
      consent: input.consent, createdBy: o.actor.kind === "staff" ? o.actor.ctx.user.id : null,
    })).id;
  }
  const cust = await db.maybe<{ vip: boolean }>(`SELECT vip FROM customers WHERE id=$1`, [customerId]);

  const dep = depositFor(loc, input.partySize, input.source);
  let status: Status = input.status ?? "confirmed";
  if (channel === "online") status = loc.autoConfirm && !dep.needed ? "confirmed" : "pending";
  if (o.seatNow) status = "confirmed";
  const code = await generateCode(db);

  let r: { id: string };
  try {
    r = await db.one<{ id: string }>(
      `INSERT INTO reservations (org_id, location_id, customer_id, code, guest_name, guest_phone, guest_email, party_size, service_date, start_at, end_at, service_id,
          status, source, occasion, special_requests, internal_notes, seating_preference, is_vip, is_private_event, language, deposit_status, deposit_amount, campaign_id, offer_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING id`,
      [o.orgId, loc.id, customerId, code, input.guestName.trim(), phone, email, input.partySize, input.date, start, end, w?.serviceId ?? null, status, input.source,
        nullIfEmpty(input.occasion), nullIfEmpty(input.specialRequests), nullIfEmpty(input.internalNotes), nullIfEmpty(input.seatingPreference),
        input.isVip ?? cust?.vip ?? false, input.isPrivateEvent ?? false, input.language ?? null, dep.needed ? "pending" : "none", dep.amount,
        o.campaignId ?? null, o.offerId ?? null, o.actor.kind === "staff" ? o.actor.ctx.user.id : null]);
    for (const tid of tableIds!) {
      await db.exec(`INSERT INTO reservation_tables (reservation_id, table_id, org_id, location_id, during) VALUES ($1,$2,$3,$4,$5::tstzrange)`,
        [r.id, tid, o.orgId, loc.id, rangeSql(start, tableEnd)]);
    }
  } catch (e) {
    const code = (e as { code?: string; constraint?: string }).code;
    if (code === "23P01") throw conflict("That table was just booked by someone else", "TABLE_CONFLICT");
    if (code === "23505" && (e as { constraint?: string }).constraint === "reservations_no_exact_dup") throw conflict("This guest already has a reservation at that time", "DUPLICATE_RESERVATION");
    throw e;
  }
  if (holdHash) await db.exec(`DELETE FROM slot_holds WHERE token_hash=$1`, [holdHash]);

  if (o.actor.kind === "staff") await audit(db, o.actor.ctx, "reservation.create", "reservation", r.id, { code, partySize: input.partySize, source: input.source });
  await notifyChange(db, o.orgId, loc.id, "reservation");
  const ver = Date.now();
  await dispatchEvent(db, { type: "reservation_created", orgId: o.orgId, locationId: loc.id, reservationId: r.id, version: ver });
  if (status === "confirmed" && !o.seatNow) await dispatchEvent(db, { type: "reservation_confirmed", orgId: o.orgId, locationId: loc.id, reservationId: r.id, version: ver });
  return { id: r.id, code, status, tableIds: tableIds!, startAt: start, endAt: end, customerId, deposit: dep };
}

export const createReservation = (ctx: Ctx, input: BookingInput) =>
  withOrg(ctx.orgId, (db) => createReservationTx(db, input, { orgId: ctx.orgId, actor: { kind: "staff", ctx } }));

// ───────────────────────────── Read models ─────────────────────────────
export const listFilterSchema = z.object({
  locationId: z.string().uuid().optional(),
  date: z.string().refine(isDateStr).optional(),
  from: z.string().refine(isDateStr).optional(),
  to: z.string().refine(isDateStr).optional(),
  status: z.string().optional(),            // comma-separated
  q: z.string().max(100).optional(),
  minParty: z.coerce.number().int().min(1).optional(),
  maxParty: z.coerce.number().int().min(1).optional(),
  source: z.string().optional(),
  timeFrom: z.string().refine(isTimeStr).optional(),
  timeTo: z.string().refine(isTimeStr).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function listReservations(db: Db, ctx: Ctx, f: z.infer<typeof listFilterSchema>) {
  const where = ["r.org_id = $1", "($2::uuid[] IS NULL OR r.location_id = ANY($2))"];
  const params: unknown[] = [ctx.orgId, ctx.locationIds];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (f.locationId) { assertLocationAccess(ctx, f.locationId); where.push(`r.location_id = ${p(f.locationId)}`); }
  if (f.date) where.push(`r.service_date = ${p(f.date)}`);
  if (f.from) where.push(`r.service_date >= ${p(f.from)}`);
  if (f.to) where.push(`r.service_date <= ${p(f.to)}`);
  if (f.status) where.push(`r.status = ANY(${p(f.status.split(",").filter(Boolean))}::text[])`);
  if (f.source) where.push(`r.source = ANY(${p(f.source.split(",").filter(Boolean))}::text[])`);
  if (f.minParty) where.push(`r.party_size >= ${p(f.minParty)}`);
  if (f.maxParty) where.push(`r.party_size <= ${p(f.maxParty)}`);
  if (f.timeFrom) where.push(`(r.start_at AT TIME ZONE l.timezone)::time >= ${p(f.timeFrom)}::time`);
  if (f.timeTo) where.push(`(r.start_at AT TIME ZONE l.timezone)::time <= ${p(f.timeTo)}::time`);
  if (f.q) {
    const s = `%${f.q.trim().replace(/[%_\\]/g, "\\$&")}%`;
    const digits = f.q.replace(/[^\d+]/g, "");
    where.push(`(r.guest_name ILIKE ${p(s)} OR r.code ILIKE ${p(s)} OR r.guest_email ILIKE ${p(s)} OR ${digits.length >= 3 ? `r.guest_phone LIKE ${p("%" + digits.replace(/^0/, "") + "%")}` : "false"})`);
  }
  const rows = await db.query(
    `SELECT r.id, r.code, r.location_id, l.name AS location_name, l.timezone, r.customer_id, r.guest_name, r.guest_phone, r.guest_email, r.party_size, r.service_date,
            r.start_at, r.end_at, r.status, r.source, r.occasion, r.special_requests, r.internal_notes, r.seating_preference, r.is_vip, r.is_private_event,
            r.deposit_status, r.deposit_amount, r.arrived_at, r.seated_at, r.completed_at,
            COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name) ORDER BY t.name) FROM reservation_tables rt JOIN tables t ON t.id=rt.table_id WHERE rt.reservation_id=r.id), '[]'::json) AS tables,
            c.allergies, c.dietary, c.vip AS customer_vip,
            (SELECT count(*) FROM visits v WHERE v.customer_id = r.customer_id)::int AS customer_visits
       FROM reservations r JOIN locations l ON l.id = r.location_id LEFT JOIN customers c ON c.id = r.customer_id
      WHERE ${where.join(" AND ")} ORDER BY r.start_at, r.created_at LIMIT ${f.limit} OFFSET ${f.offset}`, params);
  return rows;
}

export async function getReservation(db: Db, ctx: Ctx, id: string) {
  const r = await db.maybe(
    `SELECT r.*, l.name AS location_name, l.timezone, l.cleaning_workflow, l.no_show_grace_min FROM reservations r JOIN locations l ON l.id=r.location_id
      WHERE r.id=$1 AND r.org_id=$2 AND ($3::uuid[] IS NULL OR r.location_id = ANY($3))`, [id, ctx.orgId, ctx.locationIds]);
  if (!r) throw notFound("Reservation");
  const tables = await db.query(`SELECT t.id, t.name, t.capacity, t.status FROM reservation_tables rt JOIN tables t ON t.id=rt.table_id WHERE rt.reservation_id=$1 ORDER BY t.name`, [id]);
  const customer = r.customerId
    ? await db.maybe(`SELECT id, name, vip, tags, allergies, dietary, seating_preferences, notes, birthday, anniversary,
                        (SELECT count(*) FROM visits v WHERE v.customer_id=c.id)::int AS visits,
                        (SELECT max(seated_at) FROM visits v WHERE v.customer_id=c.id) AS last_visit,
                        (SELECT count(*) FROM reservations x WHERE x.customer_id=c.id AND x.status='no_show')::int AS no_shows
                   FROM customers c WHERE c.id=$1 AND c.org_id=$2`, [r.customerId, ctx.orgId])
    : null;
  return { ...r, tables, customer, manageLink: `/r/${manageToken(r.id)}` };
}

// ───────────────────────────── Updates ─────────────────────────────
export const updateSchema = z.object({
  guestName: z.string().trim().min(1).max(120).optional(),
  guestPhone: z.string().trim().max(32).nullable().optional().or(z.literal("")),
  guestEmail: z.string().trim().email().max(200).nullable().optional().or(z.literal("")),
  occasion: z.string().trim().max(60).nullable().optional(),
  specialRequests: z.string().trim().max(1000).nullable().optional(),
  internalNotes: z.string().trim().max(2000).nullable().optional(),
  seatingPreference: z.string().trim().max(200).nullable().optional(),
  isVip: z.boolean().optional(),
  isPrivateEvent: z.boolean().optional(),
  partySize: z.number().int().min(1).max(500).optional(),
  date: z.string().refine(isDateStr).optional(),
  time: z.string().refine(isTimeStr).optional(),
  tableIds: z.array(z.string().uuid()).min(1).max(10).optional(),
  depositStatus: z.enum(["none", "pending", "paid", "waived", "refunded"]).optional(),
  force: z.boolean().optional(),
});
export type UpdateInput = z.infer<typeof updateSchema>;

interface ResRow {
  id: string; orgId: string; locationId: string; status: Status; partySize: number; startAt: Date; endAt: Date; serviceDate: string;
  customerId: string | null; guestPhone: string | null; guestEmail: string | null; updatedAt: Date;
}

async function lockReservation(db: Db, orgId: string, id: string): Promise<ResRow> {
  const r = await db.maybe<ResRow>(`SELECT * FROM reservations WHERE id=$1 AND org_id=$2 FOR UPDATE`, [id, orgId]);
  if (!r) throw notFound("Reservation");
  return r;
}

/** Re-validates and re-allocates tables for a changed time / party size / explicit table choice. */
async function reallocate(db: Db, loc: LocationRow, r: ResRow, change: { date: string; time: string; partySize: number; tableIds?: string[]; channel: "online" | "staff"; force: boolean; now: Date }) {
  const day = await loadDay(db, loc, change.date, { excludeReservationId: r.id, now: change.now });
  const startMin = timeToMin(change.time);
  const w = windowFor(day, startMin);
  if (!w && !change.force) throw unprocessable(RULE_REASON_MSG.closed[1], "CLOSED");
  if (change.channel === "online" && w && (startMin - w.startMin) % w.intervalMin !== 0) throw unprocessable("That start time is not offered", "INVALID_SLOT");
  const slot = evaluateStart(day, change.date, startMin, w, { channel: change.channel, partySize: change.partySize, now: change.now });
  const start = new Date(slot.startAt);
  const end = new Date(slot.endAt);
  const tableEnd = new Date(end.getTime() + loc.bufferMin * 60_000);
  const hardFail = !slot.available && slot.reason !== "full" && !change.force;
  if (hardFail) { const [c, m] = RULE_REASON_MSG[slot.reason ?? "full"]; throw unprocessable(m, c); }

  let tableIds: string[] | null = null;
  if (change.tableIds?.length) {
    const err = validateManualAssignment({ tables: day.tables, combos: day.combos, busy: day.busy, tableIds: change.tableIds, start: start.getTime(), end: tableEnd.getTime(), party: change.partySize });
    if (err) throw conflict(`Cannot assign the selected table(s): ${err}`, err);
    tableIds = change.tableIds;
  } else {
    // prefer keeping the current tables when they still fit
    const cur = (await db.query<{ tableId: string }>(`SELECT table_id FROM reservation_tables WHERE reservation_id=$1`, [r.id])).map((x) => x.tableId);
    if (cur.length && !validateManualAssignment({ tables: day.tables, combos: day.combos, busy: day.busy, tableIds: cur, start: start.getTime(), end: tableEnd.getTime(), party: change.partySize })) tableIds = cur;
    else tableIds = pickTables({ tables: day.tables, combos: day.combos, busy: day.busy, start: start.getTime(), end: tableEnd.getTime(), party: change.partySize, onlineOnly: change.channel === "online" });
  }
  if (!tableIds) throw conflict(RULE_REASON_MSG.full[1], "NO_AVAILABILITY");
  await db.exec(`DELETE FROM reservation_tables WHERE reservation_id=$1`, [r.id]);
  try {
    for (const tid of tableIds) {
      await db.exec(`INSERT INTO reservation_tables (reservation_id, table_id, org_id, location_id, during) VALUES ($1,$2,$3,$4,$5::tstzrange)`, [r.id, tid, r.orgId, r.locationId, rangeSql(start, tableEnd)]);
    }
  } catch (e) {
    if ((e as { code?: string }).code === "23P01") throw conflict("That table was just booked by someone else", "TABLE_CONFLICT");
    throw e;
  }
  return { start, end, tableIds, serviceId: w?.serviceId ?? null };
}

async function applyUpdate(db: Db, loc: LocationRow, r: ResRow, input: UpdateInput, actor: Actor, now: Date) {
  if (!isActive(r.status)) throw conflict(`A ${r.status.replace("_", " ")} reservation cannot be edited`, "INVALID_STATE");
  const sets: string[] = []; const params: unknown[] = [r.id];
  const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  const nextParty = input.partySize ?? r.partySize;
  const nextDate = input.date ?? r.serviceDate;
  const nextTime = input.time ?? timeOf(r.startAt, loc.timezone);
  const timeChanged = nextDate !== r.serviceDate || nextTime !== timeOf(r.startAt, loc.timezone);
  const partyChanged = nextParty !== r.partySize;
  if ((timeChanged || partyChanged || input.tableIds) && r.status === "seated" && (timeChanged || partyChanged)) {
    throw conflict("A seated reservation's time or party size cannot be changed", "INVALID_STATE");
  }
  if (timeChanged || partyChanged || input.tableIds) {
    const res = await reallocate(db, loc, r, { date: nextDate, time: nextTime, partySize: nextParty, tableIds: input.tableIds, channel: actor.kind === "guest" ? "online" : "staff", force: actor.kind === "staff" && !!input.force, now });
    if (timeChanged) { set("service_date", nextDate); set("start_at", res.start); set("end_at", res.end); set("service_id", res.serviceId); sets.push("reschedule_count = reschedule_count + 1"); }
    else if (partyChanged) { set("end_at", res.end); }
    if (partyChanged) set("party_size", nextParty);
  }
  const phone = input.guestPhone !== undefined ? normalizePhone(nullIfEmpty(input.guestPhone)) : undefined;
  if (input.guestPhone && phone === null) throw badRequest("Invalid phone number", "INVALID_PHONE");
  if (input.guestName !== undefined) set("guest_name", input.guestName);
  if (phone !== undefined) set("guest_phone", phone);
  if (input.guestEmail !== undefined) set("guest_email", normalizeEmail(nullIfEmpty(input.guestEmail)));
  if (input.occasion !== undefined) set("occasion", nullIfEmpty(input.occasion));
  if (input.specialRequests !== undefined) set("special_requests", nullIfEmpty(input.specialRequests));
  if (input.internalNotes !== undefined) set("internal_notes", nullIfEmpty(input.internalNotes));
  if (input.seatingPreference !== undefined) set("seating_preference", nullIfEmpty(input.seatingPreference));
  if (input.isVip !== undefined) set("is_vip", input.isVip);
  if (input.isPrivateEvent !== undefined) set("is_private_event", input.isPrivateEvent);
  if (input.depositStatus !== undefined) set("deposit_status", input.depositStatus);
  if (sets.length) await db.exec(`UPDATE reservations SET ${sets.join(", ")} WHERE id = $1`, params);
  return { timeChanged, partyChanged };
}

export async function updateReservation(ctx: Ctx, id: string, input: UpdateInput) {
  return withOrg(ctx.orgId, async (db) => {
    const cur = await db.maybe<{ locationId: string }>(`SELECT location_id FROM reservations WHERE id=$1 AND org_id=$2`, [id, ctx.orgId]);
    if (!cur) throw notFound("Reservation");
    assertLocationAccess(ctx, cur.locationId);
    await lockLocation(db, cur.locationId);
    const r = await lockReservation(db, ctx.orgId, id);
    const loc = await loadLocation(db, r.locationId);
    const ch = await applyUpdate(db, loc, r, input, { kind: "staff", ctx }, new Date());
    await audit(db, ctx, "reservation.update", "reservation", id, { fields: Object.keys(input).filter((k) => k !== "force") });
    await notifyChange(db, ctx.orgId, r.locationId, "reservation");
    if (ch.timeChanged || ch.partyChanged) {
      await dispatchEvent(db, { type: "reservation_modified", orgId: ctx.orgId, locationId: r.locationId, reservationId: id, version: Date.now() });
    }
    return { ok: true };
  });
}

// ───────────────────────────── Lifecycle transitions ─────────────────────────────
export const transitionSchema = z.object({
  action: z.enum(["confirm", "arrive", "seat", "complete", "cancel", "no_show", "undo_arrive", "undo_seat", "reinstate"]),
  reason: z.string().trim().max(300).optional(),
  tableIds: z.array(z.string().uuid()).min(1).max(10).optional(),
  spendAmount: z.number().min(0).max(1_000_000).optional(),
  force: z.boolean().optional(),
});
export type TransitionInput = z.infer<typeof transitionSchema>;

async function tableStates(db: Db, reservationId: string) {
  return db.query<{ id: string; name: string; status: string }>(
    `SELECT t.id, t.name, t.status FROM reservation_tables rt JOIN tables t ON t.id=rt.table_id WHERE rt.reservation_id=$1 FOR UPDATE OF t`, [reservationId]);
}

export async function transitionReservationTx(db: Db, orgId: string, id: string, input: TransitionInput, actor: Actor, now = new Date()) {
  const peek = await db.maybe<{ locationId: string }>(`SELECT location_id FROM reservations WHERE id=$1 AND org_id=$2`, [id, orgId]);
  if (!peek) throw notFound("Reservation");
  if (actor.kind === "staff") assertLocationAccess(actor.ctx, peek.locationId);
  await lockLocation(db, peek.locationId);
  const r = await lockReservation(db, orgId, id);
  const loc = await loadLocation(db, r.locationId);
  const a = input.action as Action;
  if (!canTransition(r.status, a)) throw conflict(`Cannot ${a.replace("_", " ")} a reservation that is ${r.status.replace("_", " ")}`, "INVALID_TRANSITION", { from: r.status, action: a });
  const to = TRANSITIONS[a].to;
  const ver = Date.now();

  switch (a) {
    case "confirm":
      await db.exec(`UPDATE reservations SET status='confirmed' WHERE id=$1`, [id]);
      await dispatchEvent(db, { type: "reservation_confirmed", orgId, locationId: r.locationId, reservationId: id, version: ver });
      break;
    case "arrive":
      await db.exec(`UPDATE reservations SET status='arrived', arrived_at=now() WHERE id=$1`, [id]);
      break;
    case "undo_arrive":
      await db.exec(`UPDATE reservations SET status='confirmed', arrived_at=NULL WHERE id=$1`, [id]);
      break;
    case "seat": {
      if (input.tableIds?.length) {
        const day = await loadDay(db, loc, serviceDateOf(r.startAt, loc.timezone), { excludeReservationId: id, now });
        const end = new Date(r.endAt.getTime() + loc.bufferMin * 60_000);
        const err = validateManualAssignment({ tables: day.tables, combos: day.combos, busy: day.busy, tableIds: input.tableIds, start: Math.min(r.startAt.getTime(), now.getTime()), end: end.getTime(), party: r.partySize });
        if (err) throw conflict(`Cannot seat at the selected table(s): ${err}`, err);
        await db.exec(`DELETE FROM reservation_tables WHERE reservation_id=$1`, [id]);
        try {
          for (const tid of input.tableIds) {
            await db.exec(`INSERT INTO reservation_tables (reservation_id, table_id, org_id, location_id, during) VALUES ($1,$2,$3,$4,$5::tstzrange)`,
              [id, tid, orgId, r.locationId, rangeSql(new Date(Math.min(r.startAt.getTime(), now.getTime())), end)]);
          }
        } catch (e) {
          if ((e as { code?: string }).code === "23P01") throw conflict("That table is taken by another reservation", "TABLE_CONFLICT");
          throw e;
        }
      }
      const tables = await tableStates(db, id);
      if (!tables.length) throw conflict("Assign a table before seating this party", "NO_TABLE");
      const bad = tables.find((t) => t.status === "blocked" || t.status === "occupied" || (t.status === "cleaning" && !input.force));
      if (bad) throw conflict(`Table ${bad.name} is ${bad.status === "cleaning" ? "awaiting cleaning" : bad.status}`, bad.status === "cleaning" ? "TABLE_NOT_READY" : "TABLE_UNAVAILABLE", { table: bad.name });
      await db.exec(`UPDATE tables SET status='occupied' WHERE id = ANY($1)`, [tables.map((t) => t.id)]);
      await db.exec(`UPDATE reservations SET status='seated', seated_at=now(), arrived_at=COALESCE(arrived_at, now()) WHERE id=$1`, [id]);
      await db.exec(`INSERT INTO visits (org_id, location_id, customer_id, reservation_id, party_size, table_ids, seated_at) VALUES ($1,$2,$3,$4,$5,$6,now())
                      ON CONFLICT (reservation_id) WHERE reservation_id IS NOT NULL DO NOTHING`, [orgId, r.locationId, r.customerId, id, r.partySize, tables.map((t) => t.id)]);
      break;
    }
    case "undo_seat": {
      await db.exec(`UPDATE tables SET status='available' WHERE id IN (SELECT table_id FROM reservation_tables WHERE reservation_id=$1)`, [id]);
      await db.exec(`DELETE FROM visits WHERE reservation_id=$1`, [id]);
      await db.exec(`UPDATE reservations SET status='arrived', seated_at=NULL WHERE id=$1`, [id]);
      break;
    }
    case "complete": {
      // release the tables at the actual end of the visit
      await db.exec(`UPDATE reservation_tables SET during = tstzrange(lower(during), GREATEST($2::timestamptz, lower(during) + interval '1 millisecond'), '[)')
                      WHERE reservation_id=$1 AND upper(during) > $2::timestamptz`, [id, now]);
      await db.exec(`UPDATE tables SET status=$2 WHERE id IN (SELECT table_id FROM reservation_tables WHERE reservation_id=$1)`, [id, loc.cleaningWorkflow ? "cleaning" : "available"]);
      await db.exec(`UPDATE reservations SET status='completed', completed_at=$2, end_at=GREATEST(LEAST(end_at, $2), start_at + interval '1 minute') WHERE id=$1`, [id, now]);
      await db.exec(`UPDATE visits SET left_at=$2, spend_amount=COALESCE($3, spend_amount), spend_source=CASE WHEN $3::numeric IS NOT NULL THEN 'manual' ELSE spend_source END WHERE reservation_id=$1`, [id, now, input.spendAmount ?? null]);
      break;
    }
    case "cancel": {
      await db.exec(`DELETE FROM reservation_tables WHERE reservation_id=$1`, [id]);
      await db.exec(`UPDATE reservations SET status='cancelled', cancelled_at=now(), cancelled_by=$2, cancel_reason=$3 WHERE id=$1`, [id, actor.kind === "guest" ? "guest" : "staff", input.reason ?? null]);
      await dispatchEvent(db, { type: "reservation_cancelled", orgId, locationId: r.locationId, reservationId: id, version: ver });
      break;
    }
    case "no_show": {
      const graceEnd = r.startAt.getTime() + loc.noShowGraceMin * 60_000;
      if (now.getTime() < graceEnd && !input.force) throw conflict(`A no-show can be recorded ${loc.noShowGraceMin} minutes after the reservation time`, "TOO_EARLY_FOR_NO_SHOW");
      await db.exec(`DELETE FROM reservation_tables WHERE reservation_id=$1`, [id]);
      await db.exec(`UPDATE reservations SET status='no_show', no_show_at=now() WHERE id=$1`, [id]);
      break;
    }
    case "reinstate": {
      // re-run allocation: the table may have been given away meanwhile
      await reallocate(db, loc, r, { date: r.serviceDate, time: timeOf(r.startAt, loc.timezone), partySize: r.partySize, channel: "staff", force: true, now });
      await db.exec(`UPDATE reservations SET status='confirmed', no_show_at=NULL WHERE id=$1`, [id]);
      break;
    }
  }
  if (actor.kind === "staff") await audit(db, actor.ctx, `reservation.${a}`, "reservation", id, { from: r.status, to, reason: input.reason });
  else await audit(db, null, `reservation.${a}`, "reservation", id, { from: r.status, to, by: "guest" }, { orgId });
  await notifyChange(db, orgId, r.locationId, "reservation");
  return { id, status: to };
}

export const transitionReservation = (ctx: Ctx, id: string, input: TransitionInput) =>
  withOrg(ctx.orgId, (db) => transitionReservationTx(db, ctx.orgId, id, input, { kind: "staff", ctx }));

// ───────────────────────────── Walk-ins ─────────────────────────────
export const walkInSchema = z.object({
  locationId: z.string().uuid(),
  partySize: z.number().int().min(1).max(100),
  guestName: z.string().trim().max(120).optional(),
  guestPhone: z.string().trim().max(32).optional().nullable().or(z.literal("")),
  guestEmail: z.string().trim().email().optional().nullable().or(z.literal("")),
  tableIds: z.array(z.string().uuid()).max(10).optional(),
  notes: z.string().trim().max(500).optional(),
  waitlistEntryId: z.string().uuid().optional(),
});

/** Seat a party that has no reservation: creates a walk-in reservation already seated, atomically. */
export async function seatWalkIn(ctx: Ctx, input: z.infer<typeof walkInSchema>) {
  return withOrg(ctx.orgId, async (db) => {
    const loc = await loadLocation(db, input.locationId);
    assertLocationAccess(ctx, loc.id);
    const now = new Date();
    const date = serviceDateOf(now, loc.timezone);
    const res = await createReservationTx(db, {
      locationId: loc.id, date, time: timeOf(now, loc.timezone), partySize: input.partySize, guestName: input.guestName || "Walk-in",
      guestPhone: input.guestPhone ?? null, guestEmail: input.guestEmail ?? null, source: "walk_in", tableIds: input.tableIds, internalNotes: input.notes,
      allowDuplicate: true, force: true,
    }, { orgId: ctx.orgId, actor: { kind: "staff", ctx }, now, seatNow: true });
    await transitionReservationTx(db, ctx.orgId, res.id, { action: "seat" }, { kind: "staff", ctx }, now);
    if (input.waitlistEntryId) {
      const w = await db.maybe(`UPDATE waitlist_entries SET status='seated', seated_at=now(), closed_at=now(), reservation_id=$2, customer_id=COALESCE(customer_id,$3)
                                 WHERE id=$1 AND org_id=$4 AND status IN ('waiting','notified') RETURNING id`, [input.waitlistEntryId, res.id, res.customerId, ctx.orgId]);
      if (!w) throw conflict("That waitlist entry is no longer active", "WAITLIST_NOT_ACTIVE");
      await db.exec(`UPDATE visits SET waitlist_entry_id=$2 WHERE reservation_id=$1`, [res.id, input.waitlistEntryId]);
    }
    return { id: res.id, code: res.code, tableIds: res.tableIds };
  });
}

// ───────────────────────────── Guest self-service (public, token based) ─────────────────────────────
export async function getPublicReservation(token: string) {
  const id = verifyManageToken(token);
  if (!id) throw notFound("Reservation");
  return withSystem(async (db) => {
    const r = await db.maybe<{
      id: string; code: string; status: Status; partySize: number; startAt: Date; endAt: Date; guestName: string; occasion: string | null; specialRequests: string | null;
      depositStatus: string; depositAmount: number; locSlug: string; locName: string; timezone: string; address: string | null; city: string | null; phone: string | null;
      cancelDeadlineHours: number; policyText: string | null; brandColor: string; defaultLocale: string; serviceDate: string; locationId: string; orgId: string; onlineBookingEnabled: boolean;
    }>(
      `SELECT r.id, r.org_id, r.location_id, r.code, r.status, r.party_size, r.start_at, r.end_at, r.guest_name, r.occasion, r.special_requests, r.deposit_status, r.deposit_amount, r.service_date,
              l.slug AS loc_slug, l.name AS loc_name, l.timezone, l.address, l.city, l.phone, l.cancel_deadline_hours, l.policy_text, l.brand_color, l.default_locale, l.online_booking_enabled
         FROM reservations r JOIN locations l ON l.id=r.location_id JOIN organizations o ON o.id=r.org_id
        WHERE r.id=$1 AND o.status IN ('trial','active','past_due')`, [id]);
    if (!r) throw notFound("Reservation");
    const deadline = new Date(r.startAt.getTime() - r.cancelDeadlineHours * 3600_000);
    const editable = (r.status === "pending" || r.status === "confirmed") && r.startAt > new Date();
    return {
      code: r.code, status: r.status, partySize: r.partySize, startAt: r.startAt, date: r.serviceDate, time: timeOf(r.startAt, r.timezone),
      guestName: r.guestName, occasion: r.occasion, specialRequests: r.specialRequests,
      deposit: { status: r.depositStatus, amount: r.depositAmount },
      restaurant: { slug: r.locSlug, name: r.locName, address: r.address, city: r.city, phone: r.phone, timezone: r.timezone, brandColor: r.brandColor, locale: r.defaultLocale, policy: r.policyText },
      canCancel: editable && new Date() <= deadline,
      canModify: editable && new Date() <= deadline && r.onlineBookingEnabled,
      changeDeadline: deadline,
    };
  });
}

async function guestScope(token: string) {
  const id = verifyManageToken(token);
  if (!id) throw notFound("Reservation");
  const r = await withSystem((db) => db.maybe<{ orgId: string; startAt: Date; cancelDeadlineHours: number; status: Status }>(
    `SELECT r.org_id, r.start_at, l.cancel_deadline_hours, r.status FROM reservations r JOIN locations l ON l.id=r.location_id JOIN organizations o ON o.id=r.org_id
      WHERE r.id=$1 AND o.status IN ('trial','active','past_due')`, [id]));
  if (!r) throw notFound("Reservation");
  return { id, ...r };
}

export async function guestCancel(token: string) {
  const s = await guestScope(token);
  if (new Date() > new Date(s.startAt.getTime() - s.cancelDeadlineHours * 3600_000)) {
    throw forbidden(`This reservation can no longer be cancelled online (deadline: ${s.cancelDeadlineHours}h before). Please contact the restaurant.`, "CANCEL_DEADLINE_PASSED");
  }
  return withOrg(s.orgId, (db) => transitionReservationTx(db, s.orgId, s.id, { action: "cancel", reason: "Cancelled by guest" }, { kind: "guest" }));
}

export const guestModifySchema = z.object({
  date: z.string().refine(isDateStr).optional(),
  time: z.string().refine(isTimeStr).optional(),
  partySize: z.number().int().min(1).max(100).optional(),
  specialRequests: z.string().trim().max(1000).nullable().optional(),
});

export async function guestModify(token: string, input: z.infer<typeof guestModifySchema>) {
  const s = await guestScope(token);
  if (new Date() > new Date(s.startAt.getTime() - s.cancelDeadlineHours * 3600_000)) {
    throw forbidden("This reservation can no longer be changed online. Please contact the restaurant.", "MODIFY_DEADLINE_PASSED");
  }
  return withOrg(s.orgId, async (db) => {
    const cur = await db.maybe<{ locationId: string }>(`SELECT location_id FROM reservations WHERE id=$1`, [s.id]);
    if (!cur) throw notFound("Reservation");
    await lockLocation(db, cur.locationId);
    const r = await lockReservation(db, s.orgId, s.id);
    if (r.status !== "pending" && r.status !== "confirmed") throw conflict("This reservation can no longer be changed", "INVALID_STATE");
    const loc = await loadLocation(db, r.locationId);
    const ch = await applyUpdate(db, loc, r, input, { kind: "guest" }, new Date());
    await audit(db, null, "reservation.guest_update", "reservation", s.id, { fields: Object.keys(input) }, { orgId: s.orgId });
    await notifyChange(db, s.orgId, r.locationId, "reservation");
    if (ch.timeChanged || ch.partyChanged) await dispatchEvent(db, { type: "reservation_modified", orgId: s.orgId, locationId: r.locationId, reservationId: s.id, version: Date.now() });
    return { ok: true };
  });
}

// ───────────────────────────── Public holds ─────────────────────────────
export async function createHold(orgId: string, input: { locationId: string; date: string; time: string; partySize: number }) {
  return withOrg(orgId, async (db) => {
    const loc = await loadLocation(db, input.locationId);
    if (!loc.onlineBookingEnabled) throw forbidden("Online booking is not available", "ONLINE_BOOKING_DISABLED");
    await lockLocation(db, loc.id);
    const now = new Date();
    const day = await loadDay(db, loc, input.date, { now });
    const startMin = timeToMin(input.time);
    const w = windowFor(day, startMin);
    if (!w || (startMin - w.startMin) % w.intervalMin !== 0) throw unprocessable("That start time is not offered", "INVALID_SLOT");
    const slot = evaluateStart(day, input.date, startMin, w, { channel: "online", partySize: input.partySize, now });
    if (!slot.available) { const [c, m] = RULE_REASON_MSG[slot.reason ?? "full"]; throw conflict(m, c); }
    const token = randomToken(24);
    const start = new Date(slot.startAt), end = new Date(new Date(slot.endAt).getTime() + loc.bufferMin * 60_000);
    const expires = new Date(now.getTime() + loc.holdMinutes * 60_000);
    await db.exec(`INSERT INTO slot_holds (org_id, location_id, token_hash, party_size, table_ids, during, expires_at) VALUES ($1,$2,$3,$4,$5,$6::tstzrange,$7)`,
      [orgId, loc.id, sha256(token), input.partySize, slot.tableIds, rangeSql(start, end), expires]);
    return { holdToken: token, expiresAt: expires, minutes: loc.holdMinutes };
  });
}
