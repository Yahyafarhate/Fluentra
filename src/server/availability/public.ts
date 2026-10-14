import { z } from "zod";
import { withSystem, withOrg } from "@/lib/db";
import { notFound, forbidden, badRequest } from "@/lib/errors";
import { isDateStr, addDays, daysBetween } from "@/lib/time";
import { todayLocal } from "@/lib/tz";
import { computeSlots, loadLocation } from "./service";
import { getPlanInfo } from "../billing/limits";

/** Resolve an active location by public slug. Cross-tenant lookup is intentional and returns only public fields. */
export async function resolvePublicLocation(slug: string) {
  const row = await withSystem((db) => db.maybe<{ id: string; orgId: string }>(
    `SELECT l.id, l.org_id FROM locations l JOIN organizations o ON o.id=l.org_id WHERE l.slug=$1 AND l.status='active' AND o.status IN ('trial','active','past_due')`, [slug]));
  if (!row) throw notFound("Restaurant");
  return row;
}

export async function getPublicRestaurant(slug: string) {
  const ref = await resolvePublicLocation(slug);
  return withOrg(ref.orgId, async (db) => {
    const loc = await loadLocation(db, ref.id);
    const services = await db.query(`SELECT name, days, to_char(start_time,'HH24:MI') AS start_time, to_char(last_seating,'HH24:MI') AS last_seating FROM services WHERE location_id=$1 AND active ORDER BY start_time`, [loc.id]);
    const plan = await getPlanInfo(db, ref.orgId);
    const sections = await db.query(`SELECT DISTINCT s.name, s.kind FROM sections s JOIN tables t ON t.section_id=s.id AND t.active AND t.bookable_online WHERE s.location_id=$1 ORDER BY s.name`, [loc.id]);
    const maxCap = await db.one<{ n: number | null }>(`SELECT max(capacity) AS n FROM tables WHERE location_id=$1 AND active AND bookable_online`, [loc.id]);
    const today = await todayLocal(db, loc.timezone);
    const branded = plan.features.includes("custom_branding");
    return {
      slug: loc.slug, name: loc.name, description: loc.description, address: loc.address, city: loc.city, phone: loc.phone, email: loc.email, website: loc.website,
      logoUrl: branded ? loc.logoUrl : null, coverUrl: branded ? loc.coverUrl : null, gallery: branded ? loc.gallery : [], brandColor: branded ? loc.brandColor : "#b08d57",
      timezone: loc.timezone, currency: loc.currency, locale: loc.defaultLocale, today, maxDate: addDays(today, loc.bookingWindowDays),
      minParty: loc.minParty, maxPartyOnline: loc.maxPartyOnline, onlineBookingEnabled: loc.onlineBookingEnabled, policy: loc.policyText, cancelDeadlineHours: loc.cancelDeadlineHours,
      autoConfirm: loc.autoConfirm, waitlistOpen: loc.publicWaitlistEnabled && loc.waitlistEnabled,
      deposit: loc.depositEnabled && plan.features.includes("deposits") ? { perGuest: loc.depositAmountPerGuest, minParty: loc.depositMinParty, currency: loc.currency, collected: false } : null,
      services, seatingOptions: sections, largestTable: maxCap.n,
    };
  });
}

export const publicSlotsQuery = z.object({ date: z.string().refine(isDateStr), partySize: z.coerce.number().int().min(1).max(100) });

/** Public availability — never exposes table ids, names or other guests' data. */
export async function getPublicSlots(slug: string, q: z.infer<typeof publicSlotsQuery>) {
  const ref = await resolvePublicLocation(slug);
  return withOrg(ref.orgId, async (db) => {
    const loc = await loadLocation(db, ref.id);
    if (!loc.onlineBookingEnabled) throw forbidden("Online booking is not available", "ONLINE_BOOKING_DISABLED");
    const today = await todayLocal(db, loc.timezone);
    if (daysBetween(today, q.date) < 0) throw badRequest("Pick a date in the future", "IN_THE_PAST");
    const res = await computeSlots(db, loc, q.date, { channel: "online", partySize: q.partySize });
    return {
      date: res.date, closed: res.closed, closedLabel: res.closedLabel, partySize: q.partySize,
      slots: res.slots.map((s) => ({ time: s.time, available: s.available, reason: s.available ? undefined : s.reason, service: s.serviceName, durationMin: s.durationMin })),
    };
  });
}

