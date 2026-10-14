import { z } from "zod";
import { Router } from "../http/router";
import { json, publicRoute } from "@/lib/api";
import { withOrg } from "@/lib/db";
import { rateLimit } from "@/lib/ratelimit";
import { badRequest, notFound } from "@/lib/errors";
import { sha256 } from "@/lib/ids";
import { getPublicRestaurant, getPublicSlots, publicSlotsQuery, resolvePublicLocation } from "../availability/public";
import { bookingInputSchema, createHold, createReservationTx, getPublicReservation, guestCancel, guestModify, guestModifySchema } from "../reservations/service";
import { manageToken } from "../notifications/service";
import { getPublicWaitlistStatus, joinWaitlistPublic, leaveWaitlistPublic, waitlistInputSchema } from "../waitlist/service";
import { unsubscribeByToken } from "../marketing/service";
import { withSystem } from "@/lib/db";
import { isDateStr, isTimeStr } from "@/lib/time";

export const publicRouter = new Router("/api/public");
const slug = z.string().min(2).max(60).regex(/^[a-z0-9-]+$/i);

publicRouter.add("GET", "/restaurants/:slug", "public", "Public restaurant profile & booking rules", publicRoute({ rate: { key: "pub-profile", limit: 120, windowSec: 60 }, csrf: false }, async (a) => getPublicRestaurant(slug.parse(a.params.slug))));

publicRouter.add("GET", "/restaurants/:slug/slots", "public", "Available time slots for a date and party size", publicRoute({ rate: { key: "pub-slots", limit: 60, windowSec: 60 }, csrf: false }, async (a) =>
  getPublicSlots(slug.parse(a.params.slug), a.query(publicSlotsQuery))));

publicRouter.add("POST", "/restaurants/:slug/holds", "public", "Temporarily hold a slot while the guest fills in details", publicRoute({ rate: { key: "pub-hold", limit: 20, windowSec: 600 } }, async (a) => {
  const ref = await resolvePublicLocation(slug.parse(a.params.slug));
  const b = await a.body(z.object({ date: z.string().refine(isDateStr), time: z.string().refine(isTimeStr), partySize: z.number().int().min(1).max(100), sectionId: z.string().uuid().optional() }));
  return json(await createHold(ref.orgId, { locationId: ref.id, ...b }), 201);
}));

const publicBookingSchema = bookingInputSchema.pick({ date: true, time: true, partySize: true, guestName: true, guestPhone: true, guestEmail: true, occasion: true, specialRequests: true, language: true, seatingPreference: true, sectionId: true }).extend({
  consent: z.object({ email: z.boolean().optional(), sms: z.boolean().optional(), whatsapp: z.boolean().optional() }).optional(),
  holdToken: z.string().max(100).optional(),
  campaignId: z.string().uuid().optional(),
  website: z.string().max(200).optional(), // honeypot: real users leave it empty
  elapsedMs: z.number().int().min(0).optional(),
});

publicRouter.add("POST", "/restaurants/:slug/bookings", "public", "Create a reservation as a guest", publicRoute({ rate: { key: "pub-book", limit: 15, windowSec: 600 } }, async (a) => {
  const ref = await resolvePublicLocation(slug.parse(a.params.slug));
  const b = await a.body(publicBookingSchema);
  // abuse prevention: honeypot + implausibly fast submits + per-contact throttling
  if (b.website) throw badRequest("Invalid submission", "SPAM_DETECTED");
  if (b.elapsedMs !== undefined && b.elapsedMs < 1200) throw badRequest("Please take a moment to review your booking", "TOO_FAST");
  const contact = (b.guestPhone || b.guestEmail || "").toLowerCase();
  if (contact) await rateLimit(`pub-book-contact:${ref.id}:${sha256(contact)}`, 6, 3600);
  const { website: _w, elapsedMs: _e, holdToken, campaignId, ...rest } = b;
  void _w; void _e;
  const res = await withOrg(ref.orgId, async (db) => {
    let cid: string | null = null;
    if (campaignId) cid = (await db.maybe<{ id: string }>(`SELECT id FROM campaigns WHERE id=$1 AND org_id=$2`, [campaignId, ref.orgId]))?.id ?? null;
    const r = await createReservationTx(db, { ...rest, locationId: ref.id, source: "online" }, { orgId: ref.orgId, actor: { kind: "guest" }, holdToken, campaignId: cid });
    return r;
  });
  return json({
    code: res.code, status: res.status, manageUrl: `/r/${manageToken(res.id)}`, startAt: res.startAt,
    deposit: res.deposit.needed ? { amount: res.deposit.amount, state: "pending", note: "Online payment is not connected. The restaurant will contact you to arrange the deposit." } : null,
  }, 201);
}));

publicRouter.add("GET", "/reservations/:token", "public", "View a reservation via its private link", publicRoute({ rate: { key: "pub-res-get", limit: 60, windowSec: 60 }, csrf: false }, async (a) => getPublicReservation(a.params.token)));
publicRouter.add("PATCH", "/reservations/:token", "public", "Change date / time / party size within policy", publicRoute({ rate: { key: "pub-res-patch", limit: 20, windowSec: 600 } }, async (a) => guestModify(a.params.token, await a.body(guestModifySchema))));
publicRouter.add("DELETE", "/reservations/:token", "public", "Cancel within the cancellation deadline", publicRoute({ rate: { key: "pub-res-del", limit: 20, windowSec: 600 } }, async (a) => guestCancel(a.params.token)));

publicRouter.add("POST", "/restaurants/:slug/waitlist", "public", "Join the digital waitlist", publicRoute({ rate: { key: "pub-wl", limit: 10, windowSec: 600 } }, async (a) => {
  const ref = await resolvePublicLocation(slug.parse(a.params.slug));
  const b = await a.body(waitlistInputSchema.omit({ locationId: true, priorityReason: true }).extend({ website: z.string().max(200).optional() }));
  if (b.website) throw badRequest("Invalid submission", "SPAM_DETECTED");
  const { website: _w, ...rest } = b;
  void _w;
  const r = await joinWaitlistPublic(ref.orgId, { ...rest, locationId: ref.id });
  return json({ statusUrl: `/w/${r.token}`, estimatedWaitMin: r.estimate.minutes, isEstimate: true, note: "This is an estimate, not a guaranteed seating time." }, 201);
}));
publicRouter.add("GET", "/waitlist/:token", "public", "Waitlist entry status", publicRoute({ rate: { key: "pub-wl-get", limit: 120, windowSec: 60 }, csrf: false }, async (a) => getPublicWaitlistStatus(a.params.token)));
publicRouter.add("DELETE", "/waitlist/:token", "public", "Leave the waitlist", publicRoute({ rate: { key: "pub-wl-del", limit: 20, windowSec: 600 } }, async (a) => leaveWaitlistPublic(a.params.token)));

publicRouter.add("POST", "/unsubscribe", "public", "One-click unsubscribe using a signed token", publicRoute({ rate: { key: "pub-unsub", limit: 20, windowSec: 600 } }, async (a) => {
  const { token } = await a.body(z.object({ token: z.string().min(10).max(300) }));
  return unsubscribeByToken(token);
}));

publicRouter.add("GET", "/feedback/:token", "public", "Feedback request details", publicRoute({ rate: { key: "pub-fb-get", limit: 60, windowSec: 60 }, csrf: false }, async (a) =>
  withSystem(async (db) => {
    const f = await db.maybe<{ submittedAt: Date | null; name: string }>(`SELECT f.submitted_at, l.name FROM feedback f JOIN locations l ON l.id=f.location_id WHERE f.token_hash=$1`, [sha256(a.params.token)]);
    if (!f) throw notFound("Feedback request");
    return { restaurant: f.name, alreadySubmitted: !!f.submittedAt };
  })));
publicRouter.add("POST", "/feedback/:token", "public", "Submit feedback", publicRoute({ rate: { key: "pub-fb-post", limit: 20, windowSec: 600 } }, async (a) => {
  const b = await a.body(z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(1500).optional() }));
  await withSystem(async (db) => {
    const n = await db.exec(`UPDATE feedback SET rating=$2, comment=$3, submitted_at=now() WHERE token_hash=$1 AND submitted_at IS NULL`, [sha256(a.params.token), b.rating, b.comment ?? null]);
    if (!n) throw notFound("Feedback request");
  });
  return { ok: true };
}));
