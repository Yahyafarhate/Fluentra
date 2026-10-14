import { z } from "zod";
import { notifyChange, type Db } from "@/lib/db";
import { assertLocationAccess, type Ctx } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { conflict, notFound, unprocessable } from "@/lib/errors";
import { isTimeStr, isValidZone, isDateStr, timeToMin } from "@/lib/time";
import { assertWithinPlan, requireFeature } from "../billing/limits";
import { createLocationWithDefaults } from "./signup";

const urlish = z.string().max(500).refine((v) => v === "" || /^https?:\/\//.test(v) || v.startsWith("/api/files/"), "Must be an http(s) URL");

export const durationRulesSchema = z.array(z.object({ maxParty: z.number().int().min(1).max(999), minutes: z.number().int().min(20).max(480) })).min(1).max(8)
  .refine((r) => r.some((x) => x.maxParty >= 999), "The last rule must cover large parties (maxParty 999)");

export const locationPatchSchema = z.object({
  name: z.string().trim().min(2).max(100),
  timezone: z.string().refine(isValidZone, "Unknown timezone"),
  address: z.string().trim().max(200).nullable(), city: z.string().trim().max(80).nullable(), country: z.string().trim().length(2),
  phone: z.string().trim().max(32).nullable(), email: z.string().trim().email().nullable().or(z.literal("")), website: urlish.nullable(),
  description: z.string().trim().max(2000).nullable(), logoUrl: urlish.nullable(), coverUrl: urlish.nullable(),
  gallery: z.array(urlish).max(12),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/), currency: z.string().length(3), defaultLocale: z.enum(["fr", "en", "ar"]),
  slotIntervalMin: z.number().int().min(5).max(120), bufferMin: z.number().int().min(0).max(120), durationRules: durationRulesSchema,
  minParty: z.number().int().min(1).max(50), maxPartyOnline: z.number().int().min(1).max(100), maxParty: z.number().int().min(1).max(500),
  bookingWindowDays: z.number().int().min(1).max(730), minNoticeMin: z.number().int().min(0).max(60 * 24 * 14), cancelDeadlineHours: z.number().int().min(0).max(24 * 14),
  autoConfirm: z.boolean(), onlineBookingEnabled: z.boolean(), maxCoversPerSlot: z.number().int().min(1).max(2000).nullable(),
  waitlistEnabled: z.boolean(), publicWaitlistEnabled: z.boolean(),
  depositEnabled: z.boolean(), depositAmountPerGuest: z.number().min(0).max(100000), depositMinParty: z.number().int().min(1).max(500),
  cleaningWorkflow: z.boolean(), noShowGraceMin: z.number().int().min(0).max(240), holdMinutes: z.number().int().min(1).max(60),
  policyText: z.string().trim().max(1500).nullable(),
  waitlistPriority: z.object({ accessibility: z.number().int().min(0).max(5), reservation_commitment: z.number().int().min(0).max(5) }),
}).partial().strict().refine((v) => v.maxPartyOnline === undefined || v.maxParty === undefined || v.maxPartyOnline <= v.maxParty, { message: "Online max party cannot exceed the overall max party", path: ["maxPartyOnline"] });
export type LocationPatch = z.infer<typeof locationPatchSchema>;

const COLS: Record<string, string> = {
  name: "name", timezone: "timezone", address: "address", city: "city", country: "country", phone: "phone", email: "email", website: "website", description: "description",
  logoUrl: "logo_url", coverUrl: "cover_url", gallery: "gallery", brandColor: "brand_color", currency: "currency", defaultLocale: "default_locale",
  slotIntervalMin: "slot_interval_min", bufferMin: "buffer_min", durationRules: "duration_rules", minParty: "min_party", maxPartyOnline: "max_party_online", maxParty: "max_party",
  bookingWindowDays: "booking_window_days", minNoticeMin: "min_notice_min", cancelDeadlineHours: "cancel_deadline_hours", autoConfirm: "auto_confirm",
  onlineBookingEnabled: "online_booking_enabled", maxCoversPerSlot: "max_covers_per_slot", waitlistEnabled: "waitlist_enabled", publicWaitlistEnabled: "public_waitlist_enabled",
  depositEnabled: "deposit_enabled", depositAmountPerGuest: "deposit_amount_per_guest", depositMinParty: "deposit_min_party", cleaningWorkflow: "cleaning_workflow",
  noShowGraceMin: "no_show_grace_min", holdMinutes: "hold_minutes", policyText: "policy_text", waitlistPriority: "waitlist_priority",
};
const JSON_COLS = new Set(["durationRules", "waitlistPriority"]);

export async function updateLocation(db: Db, ctx: Ctx, id: string, patch: LocationPatch) {
  assertLocationAccess(ctx, id);
  const cur = await db.maybe<{ maxParty: number; maxPartyOnline: number }>(`SELECT max_party, max_party_online FROM locations WHERE id=$1 AND org_id=$2 FOR UPDATE`, [id, ctx.orgId]);
  if (!cur) throw notFound("Location");
  if ((patch.maxParty ?? cur.maxParty) < (patch.maxPartyOnline ?? cur.maxPartyOnline)) throw unprocessable("Online max party cannot exceed the overall max party", "INVALID_PARTY_LIMITS");
  if (patch.depositEnabled) await requireFeature(db, ctx.orgId, "deposits");
  if (patch.logoUrl !== undefined || patch.coverUrl !== undefined || patch.gallery !== undefined || patch.brandColor !== undefined) await requireFeature(db, ctx.orgId, "custom_branding");
  const sets: string[] = []; const params: unknown[] = [id, ctx.orgId];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || !COLS[k]) continue;
    params.push(JSON_COLS.has(k) ? JSON.stringify(v) : v === "" ? null : v);
    sets.push(`${COLS[k]} = $${params.length}`);
  }
  if (!sets.length) return;
  await db.exec(`UPDATE locations SET ${sets.join(", ")} WHERE id=$1 AND org_id=$2`, params);
  await audit(db, ctx, "location.update", "location", id, { fields: Object.keys(patch) });
  await notifyChange(db, ctx.orgId, id, "settings");
}

export const newLocationSchema = z.object({ name: z.string().trim().min(2).max(100), city: z.string().trim().max(80).optional(), timezone: z.string().refine(isValidZone).optional(), address: z.string().max(200).optional(), phone: z.string().max(32).optional() });
export async function createLocation(db: Db, ctx: Ctx, input: z.infer<typeof newLocationSchema>) {
  const count = await db.one<{ n: number }>(`SELECT count(*)::int n FROM locations WHERE org_id=$1 AND status='active'`, [ctx.orgId]);
  if (count.n >= 1) await requireFeature(db, ctx.orgId, "multi_location");
  await assertWithinPlan(db, ctx.orgId, "locations");
  const loc = await createLocationWithDefaults(db, ctx.orgId, input);
  await audit(db, ctx, "location.create", "location", loc.id, { name: input.name });
  return loc;
}

export async function archiveLocation(db: Db, ctx: Ctx, id: string) {
  const n = await db.one<{ n: number }>(`SELECT count(*)::int n FROM locations WHERE org_id=$1 AND status='active'`, [ctx.orgId]);
  if (n.n <= 1) throw conflict("You need at least one active location", "LAST_LOCATION");
  const open = await db.one<{ n: number }>(`SELECT count(*)::int n FROM reservations WHERE location_id=$1 AND org_id=$2 AND status IN ('pending','confirmed','arrived','seated') AND start_at > now() - interval '1 day'`, [id, ctx.orgId]);
  if (open.n > 0) throw conflict("Cancel or move the upcoming reservations before archiving this location", "LOCATION_HAS_RESERVATIONS");
  const r = await db.exec(`UPDATE locations SET status='archived', online_booking_enabled=false WHERE id=$1 AND org_id=$2`, [id, ctx.orgId]);
  if (!r) throw notFound("Location");
  await audit(db, ctx, "location.archive", "location", id);
}

// ── service periods (opening hours) ──
export const serviceSchema = z.object({
  locationId: z.string().uuid(),
  name: z.string().trim().min(1).max(60),
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  startTime: z.string().refine(isTimeStr), lastSeating: z.string().refine(isTimeStr),
  slotIntervalMin: z.number().int().min(5).max(120).nullable().optional(),
  maxCovers: z.number().int().min(1).max(5000).nullable().optional(),
  active: z.boolean().default(true),
}).refine((s) => timeToMin(s.lastSeating) > timeToMin(s.startTime), { message: "Last seating must be after the opening time", path: ["lastSeating"] });

async function assertNoServiceOverlap(db: Db, orgId: string, s: z.infer<typeof serviceSchema>, excludeId?: string) {
  const others = await db.query<{ id: string; name: string; days: number[]; startTime: string; lastSeating: string }>(
    `SELECT id, name, days, to_char(start_time,'HH24:MI') AS start_time, to_char(last_seating,'HH24:MI') AS last_seating FROM services WHERE org_id=$1 AND location_id=$2 AND active AND ($3::uuid IS NULL OR id<>$3)`, [orgId, s.locationId, excludeId ?? null]);
  for (const o of others) {
    if (!o.days.some((d) => s.days.includes(d))) continue;
    if (timeToMin(s.startTime) <= timeToMin(o.lastSeating) && timeToMin(o.startTime) <= timeToMin(s.lastSeating)) throw conflict(`Overlaps with the "${o.name}" service on shared days`, "SERVICE_OVERLAP");
  }
}

export async function upsertService(db: Db, ctx: Ctx, input: z.infer<typeof serviceSchema>, id?: string) {
  assertLocationAccess(ctx, input.locationId);
  if (!(await db.maybe(`SELECT 1 FROM locations WHERE id=$1 AND org_id=$2`, [input.locationId, ctx.orgId]))) throw notFound("Location");
  if (input.active) await assertNoServiceOverlap(db, ctx.orgId, input, id);
  if (id) {
    const n = await db.exec(`UPDATE services SET name=$3, days=$4, start_time=$5, last_seating=$6, slot_interval_min=$7, max_covers=$8, active=$9 WHERE id=$1 AND org_id=$2 AND location_id=$10`,
      [id, ctx.orgId, input.name, input.days, input.startTime, input.lastSeating, input.slotIntervalMin ?? null, input.maxCovers ?? null, input.active, input.locationId]);
    if (!n) throw notFound("Service");
    await audit(db, ctx, "service.update", "service", id, { name: input.name });
    return { id };
  }
  const r = await db.one<{ id: string }>(`INSERT INTO services (org_id, location_id, name, days, start_time, last_seating, slot_interval_min, max_covers, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [ctx.orgId, input.locationId, input.name, input.days, input.startTime, input.lastSeating, input.slotIntervalMin ?? null, input.maxCovers ?? null, input.active]);
  await audit(db, ctx, "service.create", "service", r.id, { name: input.name });
  return r;
}

export async function deleteService(db: Db, ctx: Ctx, id: string) {
  const s = await db.maybe<{ locationId: string }>(`SELECT location_id FROM services WHERE id=$1 AND org_id=$2`, [id, ctx.orgId]);
  if (!s) throw notFound("Service");
  assertLocationAccess(ctx, s.locationId);
  await db.exec(`DELETE FROM services WHERE id=$1`, [id]);
  await audit(db, ctx, "service.delete", "service", id);
}

export const specialDaySchema = z.object({
  locationId: z.string().uuid(), date: z.string().refine(isDateStr), closed: z.boolean().default(true), label: z.string().trim().max(80).nullable().optional(),
  startTime: z.string().refine(isTimeStr).nullable().optional(), lastSeating: z.string().refine(isTimeStr).nullable().optional(),
}).refine((s) => s.closed || (s.startTime && s.lastSeating && timeToMin(s.lastSeating) > timeToMin(s.startTime)), { message: "Special opening hours need a start time and a later last seating", path: ["startTime"] });

export async function upsertSpecialDay(db: Db, ctx: Ctx, input: z.infer<typeof specialDaySchema>) {
  assertLocationAccess(ctx, input.locationId);
  if (!(await db.maybe(`SELECT 1 FROM locations WHERE id=$1 AND org_id=$2`, [input.locationId, ctx.orgId]))) throw notFound("Location");
  await db.exec(
    `INSERT INTO special_days (org_id, location_id, date, closed, label, start_time, last_seating) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (location_id, date) DO UPDATE SET closed=EXCLUDED.closed, label=EXCLUDED.label, start_time=EXCLUDED.start_time, last_seating=EXCLUDED.last_seating`,
    [ctx.orgId, input.locationId, input.date, input.closed, input.label ?? null, input.closed ? null : input.startTime, input.closed ? null : input.lastSeating]);
  await audit(db, ctx, "special_day.set", "location", input.locationId, { date: input.date, closed: input.closed });
  if (input.closed) {
    const n = await db.one<{ n: number }>(`SELECT count(*)::int n FROM reservations WHERE location_id=$1 AND service_date=$2 AND status IN ('pending','confirmed')`, [input.locationId, input.date]);
    return { affectedReservations: n.n };
  }
  return { affectedReservations: 0 };
}
export async function deleteSpecialDay(db: Db, ctx: Ctx, id: string) {
  const s = await db.maybe<{ locationId: string }>(`SELECT location_id FROM special_days WHERE id=$1 AND org_id=$2`, [id, ctx.orgId]);
  if (!s) throw notFound("Special day");
  assertLocationAccess(ctx, s.locationId);
  await db.exec(`DELETE FROM special_days WHERE id=$1`, [id]);
  await audit(db, ctx, "special_day.delete", "special_day", id);
}
