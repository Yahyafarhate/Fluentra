import { z } from "zod";
import { withOrg, type Db } from "@/lib/db";
import type { Ctx } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { channelSchema, countCustomers, queryCustomers, segmentCriteriaSchema, recordConsent, type Channel } from "../customers/service";
import { enqueueNotification, unsubscribeToken, verifyUnsubscribeToken } from "../notifications/service";
import { render } from "../notifications/templates";
import { requireFeature } from "../billing/limits";
import { channelStatus } from "../notifications/adapters";
import { withSystem } from "@/lib/db";

export const segmentSchema = z.object({ name: z.string().trim().min(1).max(100), criteria: segmentCriteriaSchema });
export async function createSegment(db: Db, ctx: Ctx, input: z.infer<typeof segmentSchema>) {
  await requireFeature(db, ctx.orgId, "marketing");
  const r = await db.one<{ id: string }>(`INSERT INTO segments (org_id, name, criteria, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.orgId, input.name, JSON.stringify(input.criteria), ctx.user.id]);
  await audit(db, ctx, "segment.create", "segment", r.id, { name: input.name });
  return r;
}
export async function listSegments(db: Db, ctx: Ctx) {
  await requireFeature(db, ctx.orgId, "marketing");
  const segs = await db.query<{ id: string; name: string; criteria: z.infer<typeof segmentCriteriaSchema>; createdAt: Date }>(`SELECT id, name, criteria, created_at FROM segments WHERE org_id=$1 ORDER BY created_at DESC`, [ctx.orgId]);
  const out = [];
  for (const s of segs) out.push({ ...s, size: await countCustomers(db, ctx.orgId, s.criteria), reachable: { email: await countCustomers(db, ctx.orgId, { ...s.criteria, consentChannel: "email" }), sms: await countCustomers(db, ctx.orgId, { ...s.criteria, consentChannel: "sms" }), whatsapp: await countCustomers(db, ctx.orgId, { ...s.criteria, consentChannel: "whatsapp" }) } });
  return out;
}
export async function deleteSegment(db: Db, ctx: Ctx, id: string) {
  const n = await db.exec(`DELETE FROM segments WHERE id=$1 AND org_id=$2`, [id, ctx.orgId]);
  if (!n) throw notFound("Segment");
  await audit(db, ctx, "segment.delete", "segment", id);
}

export const offerSchema = z.object({
  name: z.string().trim().min(1).max(100), code: z.string().trim().max(30).nullable().optional(), description: z.string().trim().max(500).nullable().optional(),
  kind: z.enum(["returning_guest", "birthday", "special_occasion", "event"]).default("returning_guest"),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), active: z.boolean().default(true),
});
export async function createOffer(db: Db, ctx: Ctx, input: z.infer<typeof offerSchema>) {
  await requireFeature(db, ctx.orgId, "marketing");
  const r = await db.one<{ id: string }>(`INSERT INTO offers (org_id, name, code, description, kind, valid_from, valid_to, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.orgId, input.name, input.code ?? null, input.description ?? null, input.kind, input.validFrom ?? null, input.validTo ?? null, input.active]);
  await audit(db, ctx, "offer.create", "offer", r.id, { name: input.name });
  return r;
}
export async function listOffers(db: Db, ctx: Ctx) {
  await requireFeature(db, ctx.orgId, "marketing");
  return db.query(`SELECT * FROM offers WHERE org_id=$1 ORDER BY created_at DESC`, [ctx.orgId]);
}
export async function setOfferActive(db: Db, ctx: Ctx, id: string, active: boolean) {
  const n = await db.exec(`UPDATE offers SET active=$3 WHERE id=$1 AND org_id=$2`, [id, ctx.orgId, active]);
  if (!n) throw notFound("Offer");
  await audit(db, ctx, "offer.toggle", "offer", id, { active });
}

export const campaignSchema = z.object({
  name: z.string().trim().min(1).max(120), channel: channelSchema, segmentId: z.string().uuid().nullable().optional(), locationId: z.string().uuid().nullable().optional(),
  offerId: z.string().uuid().nullable().optional(), subject: z.string().trim().max(200).nullable().optional(), body: z.string().trim().min(1).max(1600),
  scheduledAt: z.string().datetime().nullable().optional(),
});

async function assertRefs(db: Db, orgId: string, i: { segmentId?: string | null; offerId?: string | null; locationId?: string | null }) {
  if (i.segmentId && !(await db.maybe(`SELECT 1 FROM segments WHERE id=$1 AND org_id=$2`, [i.segmentId, orgId]))) throw notFound("Segment");
  if (i.offerId && !(await db.maybe(`SELECT 1 FROM offers WHERE id=$1 AND org_id=$2`, [i.offerId, orgId]))) throw notFound("Offer");
  if (i.locationId && !(await db.maybe(`SELECT 1 FROM locations WHERE id=$1 AND org_id=$2`, [i.locationId, orgId]))) throw notFound("Location");
}

export async function createCampaign(db: Db, ctx: Ctx, input: z.infer<typeof campaignSchema>) {
  await requireFeature(db, ctx.orgId, "marketing");
  await assertRefs(db, ctx.orgId, input);
  if (input.channel === "email" && !input.subject) throw badRequest("Email campaigns need a subject", "SUBJECT_REQUIRED");
  const r = await db.one<{ id: string }>(
    `INSERT INTO campaigns (org_id, location_id, name, channel, segment_id, offer_id, subject, body, scheduled_at, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10) RETURNING id`,
    [ctx.orgId, input.locationId ?? null, input.name, input.channel, input.segmentId ?? null, input.offerId ?? null, input.subject ?? null, input.body, input.scheduledAt ?? null, ctx.user.id]);
  await audit(db, ctx, "campaign.create", "campaign", r.id, { name: input.name, channel: input.channel });
  return r;
}

export async function campaignAudience(db: Db, orgId: string, campaignId: string) {
  const c = await db.maybe<{ id: string; channel: Channel; segmentId: string | null; locationId: string | null }>(`SELECT id, channel, segment_id, location_id FROM campaigns WHERE id=$1 AND org_id=$2`, [campaignId, orgId]);
  if (!c) throw notFound("Campaign");
  const seg = c.segmentId ? await db.maybe<{ criteria: z.infer<typeof segmentCriteriaSchema> }>(`SELECT criteria FROM segments WHERE id=$1 AND org_id=$2`, [c.segmentId, orgId]) : null;
  const criteria = { ...(seg?.criteria ?? {}), consentChannel: c.channel, ...(c.locationId ? { locationId: c.locationId } : {}) };
  const { rows } = await queryCustomers(db, orgId, criteria, { limit: 5000 });
  // only people with an address on the channel
  const reachable = rows.filter((r) => (c.channel === "email" ? r.email : r.phone));
  const total = (await queryCustomers(db, orgId, seg?.criteria ?? {}, { limit: 1 })).total;
  return { campaign: c, recipients: reachable, segmentSize: total, excludedNoConsentOrContact: total - reachable.length };
}

export async function previewAudience(db: Db, ctx: Ctx, campaignId: string) {
  const a = await campaignAudience(db, ctx.orgId, campaignId);
  return { recipients: a.recipients.length, segmentSize: a.segmentSize, excluded: a.excludedNoConsentOrContact, channel: a.campaign.channel, providerStatus: channelStatus(a.campaign.channel) };
}

export const scheduleSchema = z.object({ sendAt: z.string().datetime().nullable().optional() });
export async function launchCampaign(db: Db, ctx: Ctx, id: string, sendAt: string | null | undefined) {
  await requireFeature(db, ctx.orgId, "marketing");
  const c = await db.maybe<{ status: string; channel: Channel }>(`SELECT status, channel FROM campaigns WHERE id=$1 AND org_id=$2 FOR UPDATE`, [id, ctx.orgId]);
  if (!c) throw notFound("Campaign");
  if (c.status !== "draft" && c.status !== "scheduled") throw conflict(`A ${c.status} campaign cannot be launched`, "INVALID_STATE");
  const when = sendAt ? new Date(sendAt) : null;
  if (when && when.getTime() > Date.now() + 30_000) {
    await db.exec(`UPDATE campaigns SET status='scheduled', scheduled_at=$2 WHERE id=$1`, [id, when]);
    await audit(db, ctx, "campaign.schedule", "campaign", id, { sendAt });
    return { status: "scheduled" as const };
  }
  await db.exec(`UPDATE campaigns SET status='sending', scheduled_at=NULL WHERE id=$1`, [id]);
  await db.exec(`INSERT INTO jobs (org_id, type, payload, idempotency_key) VALUES ($3, 'send_campaign', $1, $2) ON CONFLICT DO NOTHING`, [JSON.stringify({ orgId: ctx.orgId, campaignId: id }), `campaign:${id}`, ctx.orgId]);
  await audit(db, ctx, "campaign.launch", "campaign", id);
  return { status: "sending" as const };
}

export async function cancelCampaign(db: Db, ctx: Ctx, id: string) {
  const n = await db.exec(`UPDATE campaigns SET status='cancelled' WHERE id=$1 AND org_id=$2 AND status IN ('draft','scheduled')`, [id, ctx.orgId]);
  if (!n) throw conflict("Only draft or scheduled campaigns can be cancelled", "INVALID_STATE");
  await audit(db, ctx, "campaign.cancel", "campaign", id);
}

/** Job: fan the campaign out into per-recipient notifications (idempotent per campaign + customer). */
export async function executeCampaign(orgId: string, campaignId: string) {
  await withOrg(orgId, async (db) => {
    const c = await db.maybe<{ id: string; name: string; channel: Channel; subject: string | null; body: string; offerId: string | null; locationId: string | null; status: string }>(
      `SELECT id, name, channel, subject, body, offer_id, location_id, status FROM campaigns WHERE id=$1 AND org_id=$2 FOR UPDATE`, [campaignId, orgId]);
    if (!c || c.status !== "sending") return;
    const { recipients } = await campaignAudience(db, orgId, campaignId);
    const loc = await db.maybe<{ name: string; slug: string; defaultLocale: string }>(
      `SELECT name, slug, default_locale FROM locations WHERE org_id=$1 AND status='active' AND ($2::uuid IS NULL OR id=$2) ORDER BY created_at LIMIT 1`, [orgId, c.locationId]);
    const offer = c.offerId ? await db.maybe<{ name: string; description: string | null; code: string | null }>(`SELECT name, description, code FROM offers WHERE id=$1 AND org_id=$2`, [c.offerId, orgId]) : null;
    for (const r of recipients) {
      const to = c.channel === "email" ? r.email! : r.phone!;
      const vars = {
        guest_name: r.name, restaurant: loc?.name ?? "", offer: offer ? [offer.name, offer.description, offer.code ? `Code: ${offer.code}` : null].filter(Boolean).join(" — ") : "",
        booking_link: loc ? `${env.appUrl}/book/${loc.slug}?c=${c.id}` : "", unsubscribe_link: `${env.appUrl}/u/${unsubscribeToken(r.id, c.channel)}`,
      };
      let body = render(c.body, vars);
      if (!/\/u\//.test(body)) body += `\n\n${vars.unsubscribe_link}`; // an unsubscribe link is always present
      const nid = await enqueueNotification(db, {
        orgId, locationId: c.locationId, customerId: r.id, campaignId: c.id, templateKey: "campaign", channel: c.channel, to, locale: loc?.defaultLocale ?? "fr",
        subject: c.channel === "email" ? render(c.subject ?? c.name, vars) : null, body, idempotencyKey: `camp:${c.id}:${r.id}`,
      });
      await db.exec(`INSERT INTO campaign_recipients (org_id, campaign_id, customer_id, notification_id) VALUES ($1,$2,$3,$4) ON CONFLICT (campaign_id, customer_id) DO NOTHING`, [orgId, c.id, r.id, nid]);
    }
    await db.exec(`UPDATE campaigns SET status='sent', sent_at=now() WHERE id=$1`, [c.id]);
  });
}

export async function listCampaigns(db: Db, ctx: Ctx) {
  await requireFeature(db, ctx.orgId, "marketing");
  return db.query(
    `SELECT c.id, c.name, c.channel, c.status, c.scheduled_at, c.sent_at, c.created_at, s.name AS segment_name,
            (SELECT count(*) FROM campaign_recipients cr WHERE cr.campaign_id=c.id)::int AS recipients
       FROM campaigns c LEFT JOIN segments s ON s.id=c.segment_id WHERE c.org_id=$1 ORDER BY c.created_at DESC LIMIT 100`, [ctx.orgId]);
}

/** Results are layered and never conflated: delivery (provider-confirmed) vs engagement (webhook-verified) vs bookings (link-tracked). */
export async function campaignResults(db: Db, ctx: Ctx, id: string) {
  const c = await db.maybe<{ id: string; name: string; channel: Channel; status: string; sentAt: Date | null }>(`SELECT id, name, channel, status, sent_at FROM campaigns WHERE id=$1 AND org_id=$2`, [id, ctx.orgId]);
  if (!c) throw notFound("Campaign");
  const d = await db.one<Record<string, number>>(
    `SELECT count(*)::int AS recipients, count(*) FILTER (WHERE status='queued')::int AS queued, count(*) FILTER (WHERE status='sent')::int AS sent,
            count(*) FILTER (WHERE status='delivered')::int AS delivered, count(*) FILTER (WHERE status='failed')::int AS failed,
            count(*) FILTER (WHERE status='simulated')::int AS simulated, count(*) FILTER (WHERE status='skipped')::int AS skipped,
            count(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened, count(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicked
       FROM notifications WHERE campaign_id=$1 AND org_id=$2`, [id, ctx.orgId]);
  const attributed = await db.one<{ bookings: number; covers: number }>(
    `SELECT count(*)::int AS bookings, COALESCE(sum(party_size),0)::int AS covers FROM reservations WHERE campaign_id=$1 AND org_id=$2 AND status NOT IN ('cancelled','no_show')`, [id, ctx.orgId]);
  const possible = c.sentAt ? await db.one<{ bookings: number }>(
    `SELECT count(DISTINCT r.id)::int AS bookings FROM reservations r JOIN campaign_recipients cr ON cr.customer_id=r.customer_id AND cr.campaign_id=$1
      WHERE r.org_id=$2 AND r.created_at BETWEEN $3 AND $3 + interval '7 days' AND r.campaign_id IS NULL AND r.status NOT IN ('cancelled','no_show')`, [id, ctx.orgId, c.sentAt]) : { bookings: 0 };
  return {
    campaign: c,
    delivery: { ...d, note: d.simulated > 0 ? "Messages marked simulated were never sent (no provider connected)." : null },
    engagement: { opened: d.opened, clicked: d.clicked, note: "Opens and clicks are only counted when a provider webhook reports them; none are inferred." },
    bookings: { attributed: attributed.bookings, attributedCovers: attributed.covers, possiblyInfluenced: possible.bookings,
      note: "'Attributed' bookings came through this campaign's tracked booking link. 'Possibly influenced' are bookings by recipients within 7 days without the link — an estimate, not a confirmed result." },
  };
}

export async function retentionMetrics(db: Db, ctx: Ctx) {
  const m = await db.one<{ guests12m: number; repeat: number; lapsed90: number; avgDaysBetween: number | null; newGuests30: number }>(
    `WITH v AS (SELECT customer_id, count(*) n, max(seated_at) last_at FROM visits WHERE org_id=$1 AND customer_id IS NOT NULL AND seated_at > now() - interval '12 months' GROUP BY 1),
          gaps AS (SELECT customer_id, avg(extract(epoch FROM (seated_at - lag_at))/86400) AS d FROM (SELECT customer_id, seated_at, lag(seated_at) OVER (PARTITION BY customer_id ORDER BY seated_at) AS lag_at FROM visits WHERE org_id=$1 AND customer_id IS NOT NULL) z WHERE lag_at IS NOT NULL GROUP BY 1)
     SELECT (SELECT count(*) FROM v)::int AS guests12m, (SELECT count(*) FROM v WHERE n >= 2)::int AS repeat,
            (SELECT count(*) FROM v WHERE last_at < now() - interval '90 days')::int AS lapsed90, (SELECT round(avg(d)) FROM gaps)::int AS avg_days_between,
            (SELECT count(*) FROM customers WHERE org_id=$1 AND created_at > now() - interval '30 days' AND anonymized_at IS NULL)::int AS new_guests30`, [ctx.orgId]);
  return { ...m, repeatRatePct: m.guests12m ? Math.round((1000 * m.repeat) / m.guests12m) / 10 : null };
}

/** Public unsubscribe by signed token. Records a consent withdrawal (append-only ledger). */
export async function unsubscribeByToken(token: string): Promise<{ ok: true }> {
  const t = verifyUnsubscribeToken(token);
  if (!t) throw notFound("Link");
  await withSystem(async (db) => {
    const c = await db.maybe<{ orgId: string }>(`SELECT org_id FROM customers WHERE id=$1`, [t.customerId]);
    if (!c) throw notFound("Link");
    await withOrg(c.orgId, (odb) => recordConsent(odb, c.orgId, t.customerId, t.channel, false, "unsubscribe_link"));
  });
  return { ok: true };
}
