import { z } from "zod";
import type { Db } from "@/lib/db";
import type { Ctx } from "@/lib/auth";
import { notFound, conflict, badRequest } from "@/lib/errors";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { audit } from "@/lib/audit";
import { assertLocationAccess } from "@/lib/auth";

export const channelSchema = z.enum(["email", "sms", "whatsapp"]);
export type Channel = z.infer<typeof channelSchema>;

export const segmentCriteriaSchema = z.object({
  minVisits: z.number().int().min(0).optional(),
  maxVisits: z.number().int().min(0).optional(),
  lastVisitWithinDays: z.number().int().min(1).optional(),
  lapsedDays: z.number().int().min(1).optional(),          // last visit older than N days (but at least one visit)
  neverVisited: z.boolean().optional(),
  vip: z.boolean().optional(),
  tags: z.array(z.string().max(40)).max(10).optional(),
  birthdayWithinDays: z.number().int().min(0).max(366).optional(),
  consentChannel: channelSchema.optional(),
  locationId: z.string().uuid().optional(),
  hasAllergies: z.boolean().optional(),
  minSpend: z.number().min(0).optional(),
  search: z.string().max(100).optional(),
}).strict();
export type SegmentCriteria = z.infer<typeof segmentCriteriaSchema>;

export interface CustomerListRow {
  id: string; name: string; phone: string | null; email: string | null; vip: boolean; tags: string[];
  allergies: string[]; dietary: string[]; birthday: string | null; consentEmail: boolean; consentSms: boolean; consentWhatsapp: boolean;
  visits: number; lastVisit: Date | null; totalSpend: number | null; noShows: number; createdAt: Date;
}

/** Build the shared customer + stats query. All values are bound parameters. */
function statsQuery(orgId: string, c: SegmentCriteria) {
  const params: unknown[] = [orgId];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where: string[] = ["c.org_id = $1", "c.merged_into IS NULL", "c.anonymized_at IS NULL"];
  const having: string[] = [];
  if (c.vip !== undefined) where.push(`c.vip = ${p(c.vip)}`);
  if (c.tags?.length) where.push(`c.tags && ${p(c.tags)}::text[]`);
  if (c.hasAllergies) where.push(`cardinality(c.allergies) > 0`);
  if (c.consentChannel) where.push(c.consentChannel === "email" ? "c.consent_email" : c.consentChannel === "sms" ? "c.consent_sms" : "c.consent_whatsapp");
  if (c.search) {
    const s = `%${c.search.replace(/[%_\\]/g, "\\$&")}%`;
    where.push(`(c.name ILIKE ${p(s)} OR c.phone ILIKE ${p(s)} OR c.email ILIKE ${p(s)})`);
  }
  if (c.birthdayWithinDays !== undefined) {
    const n = p(c.birthdayWithinDays);
    where.push(`c.birthday IS NOT NULL AND (
      (make_date(extract(year from now())::int, extract(month from c.birthday)::int, LEAST(extract(day from c.birthday)::int, 28)) - current_date) BETWEEN 0 AND ${n}
      OR (make_date(extract(year from now())::int + 1, extract(month from c.birthday)::int, LEAST(extract(day from c.birthday)::int, 28)) - current_date) BETWEEN 0 AND ${n})`);
  }
  const loc = c.locationId ? p(c.locationId) : null;
  if (c.minVisits !== undefined) having.push(`COALESCE(v.cnt,0) >= ${p(c.minVisits)}`);
  if (c.maxVisits !== undefined) having.push(`COALESCE(v.cnt,0) <= ${p(c.maxVisits)}`);
  if (c.neverVisited) having.push(`COALESCE(v.cnt,0) = 0`);
  if (c.lastVisitWithinDays !== undefined) having.push(`v.last_visit >= now() - make_interval(days => ${p(c.lastVisitWithinDays)})`);
  if (c.lapsedDays !== undefined) having.push(`v.last_visit IS NOT NULL AND v.last_visit < now() - make_interval(days => ${p(c.lapsedDays)})`);
  if (c.minSpend !== undefined) having.push(`COALESCE(v.spend,0) >= ${p(c.minSpend)}`);
  const sql = `
    SELECT c.id, c.name, c.phone, c.email, c.vip, c.tags, c.allergies, c.dietary, c.birthday,
           c.consent_email, c.consent_sms, c.consent_whatsapp, c.created_at,
           COALESCE(v.cnt,0)::int AS visits, v.last_visit, v.spend AS total_spend,
           COALESCE(ns.cnt,0)::int AS no_shows
      FROM customers c
      LEFT JOIN (SELECT customer_id, count(*) cnt, max(seated_at) last_visit, sum(spend_amount) spend
                   FROM visits WHERE org_id = $1 ${loc ? `AND location_id = ${loc}` : ""} GROUP BY customer_id) v ON v.customer_id = c.id
      LEFT JOIN (SELECT customer_id, count(*) cnt FROM reservations WHERE org_id = $1 AND status = 'no_show' GROUP BY customer_id) ns ON ns.customer_id = c.id
     WHERE ${where.join(" AND ")} ${having.length ? "AND " + having.join(" AND ") : ""}`;
  return { sql, params };
}

export async function queryCustomers(db: Db, orgId: string, criteria: SegmentCriteria, opts: { limit?: number; offset?: number; sort?: string } = {}) {
  const { sql, params } = statsQuery(orgId, criteria);
  const order = ({
    name: "name ASC", recent: "last_visit DESC NULLS LAST", visits: "visits DESC, name ASC", created: "created_at DESC",
  } as Record<string, string>)[opts.sort ?? "name"] ?? "name ASC";
  const limit = Math.min(opts.limit ?? 50, 5000);
  const rows = await db.query<CustomerListRow>(`SELECT * FROM (${sql}) q ORDER BY ${order} LIMIT ${limit} OFFSET ${Math.max(0, opts.offset ?? 0)}`, params);
  const total = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`, params);
  return { rows, total: total.n };
}

export async function countCustomers(db: Db, orgId: string, criteria: SegmentCriteria) {
  const { sql, params } = statsQuery(orgId, criteria);
  return (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`, params)).n;
}

export const customerInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(32).optional().nullable(),
  email: z.string().trim().email().max(200).optional().nullable().or(z.literal("")),
  language: z.enum(["fr", "en", "ar"]).optional().nullable(),
  vip: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  dietary: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  allergies: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  seatingPreferences: z.string().max(300).optional().nullable(),
  preferredLocationId: z.string().uuid().optional().nullable(),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  anniversary: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});
export type CustomerInput = z.infer<typeof customerInputSchema>;

export async function recordConsent(db: Db, orgId: string, customerId: string, channel: Channel, granted: boolean, source: string, createdBy: string | null = null, note?: string) {
  const col = channel === "email" ? "consent_email" : channel === "sms" ? "consent_sms" : "consent_whatsapp";
  const cur = await db.maybe<{ v: boolean }>(`SELECT ${col} AS v FROM customers WHERE id=$1 AND org_id=$2`, [customerId, orgId]);
  if (!cur) throw notFound("Customer");
  if (cur.v === granted) return;
  await db.exec(`UPDATE customers SET ${col} = $1 WHERE id = $2 AND org_id = $3`, [granted, customerId, orgId]);
  await db.exec(`INSERT INTO consents (org_id, customer_id, channel, granted, source, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [orgId, customerId, channel, granted, source, note ?? null, createdBy]);
}

/**
 * Match a booking to an existing guest using only reliable identifiers (exact normalized phone, then exact email).
 * Names are never used for matching. Creates a profile when nothing matches.
 */
export async function resolveCustomer(db: Db, orgId: string, input: {
  name: string; phone?: string | null; email?: string | null; language?: string | null; source?: string;
  consent?: Partial<Record<Channel, boolean>>; createdBy?: string | null;
}): Promise<{ id: string; created: boolean }> {
  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);
  let row: { id: string } | null = null;
  if (phone) row = await db.maybe(`SELECT id FROM customers WHERE org_id=$1 AND phone=$2 AND merged_into IS NULL AND anonymized_at IS NULL`, [orgId, phone]);
  if (!row && email) row = await db.maybe(`SELECT id FROM customers WHERE org_id=$1 AND email=$2 AND merged_into IS NULL AND anonymized_at IS NULL`, [orgId, email]);
  let created = false;
  if (!row) {
    row = await db.one<{ id: string }>(
      `INSERT INTO customers (org_id, name, phone, email, language, source) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [orgId, input.name.trim(), phone, email, input.language ?? null, input.source ?? null]);
    created = true;
  } else {
    // enrich only empty fields; never overwrite what staff recorded, and never take an email/phone that belongs to another profile
    await db.exec(
      `UPDATE customers SET
         email = COALESCE(email, CASE WHEN $3::citext IS NOT NULL AND NOT EXISTS
             (SELECT 1 FROM customers o WHERE o.org_id=$1 AND o.email=$3::citext AND o.id<>$2 AND o.merged_into IS NULL AND o.anonymized_at IS NULL) THEN $3::citext END),
         phone = COALESCE(phone, CASE WHEN $4::text IS NOT NULL AND NOT EXISTS
             (SELECT 1 FROM customers o WHERE o.org_id=$1 AND o.phone=$4::text AND o.id<>$2 AND o.merged_into IS NULL AND o.anonymized_at IS NULL) THEN $4::text END),
         language = COALESCE(language, $5)
       WHERE id=$2 AND org_id=$1`, [orgId, row.id, email, phone, input.language ?? null]);
  }
  for (const [ch, granted] of Object.entries(input.consent ?? {})) {
    if (granted !== undefined) await recordConsent(db, orgId, row.id, ch as Channel, granted, input.source === "online" ? "booking_form" : "staff", input.createdBy ?? null);
  }
  return { id: row.id, created };
}

export async function createCustomer(db: Db, ctx: Ctx, input: CustomerInput) {
  const phone = normalizePhone(input.phone);
  if (input.phone && !phone) throw badRequest("Invalid phone number", "INVALID_PHONE");
  const email = normalizeEmail(input.email || null);
  if (input.preferredLocationId) assertLocationAccess(ctx, input.preferredLocationId);
  const dupe = await db.maybe<{ id: string; name: string }>(
    `SELECT id, name FROM customers WHERE org_id=$1 AND merged_into IS NULL AND anonymized_at IS NULL AND (($2::text IS NOT NULL AND phone=$2) OR ($3::citext IS NOT NULL AND email=$3))`,
    [ctx.orgId, phone, email]);
  if (dupe) throw conflict(`A guest with the same phone or email already exists (${dupe.name})`, "DUPLICATE_CUSTOMER", { customerId: dupe.id });
  const row = await db.one<{ id: string }>(
    `INSERT INTO customers (org_id, name, phone, email, language, vip, tags, dietary, allergies, seating_preferences, preferred_location_id, birthday, anniversary, notes, source)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,false),COALESCE($7,'{}'),COALESCE($8,'{}'),COALESCE($9,'{}'),$10,$11,$12,$13,$14,'staff') RETURNING id`,
    [ctx.orgId, input.name, phone, email, input.language ?? null, input.vip ?? null, input.tags ?? null, input.dietary ?? null, input.allergies ?? null,
      input.seatingPreferences ?? null, input.preferredLocationId ?? null, input.birthday ?? null, input.anniversary ?? null, input.notes ?? null]);
  await audit(db, ctx, "customer.create", "customer", row.id);
  return row;
}

export async function updateCustomer(db: Db, ctx: Ctx, id: string, input: Partial<CustomerInput>) {
  const cur = await db.maybe<{ id: string }>(`SELECT id FROM customers WHERE id=$1 AND org_id=$2 AND anonymized_at IS NULL AND merged_into IS NULL FOR UPDATE`, [id, ctx.orgId]);
  if (!cur) throw notFound("Customer");
  const sets: string[] = []; const params: unknown[] = [id, ctx.orgId];
  const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (input.name !== undefined) set("name", input.name);
  if (input.phone !== undefined) { const ph = normalizePhone(input.phone); if (input.phone && !ph) throw badRequest("Invalid phone number", "INVALID_PHONE"); set("phone", ph); }
  if (input.email !== undefined) set("email", normalizeEmail(input.email || null));
  if (input.language !== undefined) set("language", input.language);
  if (input.vip !== undefined) set("vip", input.vip);
  if (input.tags !== undefined) set("tags", input.tags);
  if (input.dietary !== undefined) set("dietary", input.dietary);
  if (input.allergies !== undefined) set("allergies", input.allergies);
  if (input.seatingPreferences !== undefined) set("seating_preferences", input.seatingPreferences);
  if (input.preferredLocationId !== undefined) { if (input.preferredLocationId) assertLocationAccess(ctx, input.preferredLocationId); set("preferred_location_id", input.preferredLocationId); }
  if (input.birthday !== undefined) set("birthday", input.birthday);
  if (input.anniversary !== undefined) set("anniversary", input.anniversary);
  if (input.notes !== undefined) set("notes", input.notes);
  if (!sets.length) return;
  await db.exec(`UPDATE customers SET ${sets.join(", ")} WHERE id=$1 AND org_id=$2`, params);
  await audit(db, ctx, "customer.update", "customer", id, { fields: Object.keys(input) });
}

export async function getCustomerProfile(db: Db, ctx: Ctx, id: string) {
  const c = await db.maybe<Record<string, unknown>>(`SELECT * FROM customers WHERE id=$1 AND org_id=$2 AND merged_into IS NULL`, [id, ctx.orgId]);
  if (!c) throw notFound("Customer");
  const scopeLoc = ctx.locationIds;
  const stats = await db.one<{ visits: number; lastVisit: Date | null; totalSpend: number | null; spendRecorded: number; avgParty: number | null }>(
    `SELECT count(*)::int AS visits, max(seated_at) AS last_visit, sum(spend_amount) AS total_spend,
            count(spend_amount)::int AS spend_recorded, avg(party_size) AS avg_party
       FROM visits WHERE org_id=$1 AND customer_id=$2 AND ($3::uuid[] IS NULL OR location_id = ANY($3))`, [ctx.orgId, id, scopeLoc]);
  const reservations = await db.query(
    `SELECT r.id, r.code, r.status, r.party_size, r.start_at, r.source, r.occasion, r.special_requests, l.name AS location_name, l.id AS location_id
       FROM reservations r JOIN locations l ON l.id = r.location_id
      WHERE r.org_id=$1 AND r.customer_id=$2 AND ($3::uuid[] IS NULL OR r.location_id = ANY($3))
      ORDER BY r.start_at DESC LIMIT 100`, [ctx.orgId, id, scopeLoc]);
  const counts = await db.one<{ noShows: number; cancellations: number; upcoming: number }>(
    `SELECT count(*) FILTER (WHERE status='no_show')::int AS no_shows, count(*) FILTER (WHERE status='cancelled')::int AS cancellations,
            count(*) FILTER (WHERE status IN ('pending','confirmed') AND start_at > now())::int AS upcoming
       FROM reservations WHERE org_id=$1 AND customer_id=$2`, [ctx.orgId, id]);
  const feedback = await db.query(
    `SELECT id, rating, comment, submitted_at FROM feedback WHERE org_id=$1 AND customer_id=$2 AND submitted_at IS NOT NULL ORDER BY submitted_at DESC LIMIT 20`, [ctx.orgId, id]);
  const consents = await db.query(`SELECT channel, granted, source, created_at FROM consents WHERE org_id=$1 AND customer_id=$2 ORDER BY created_at DESC LIMIT 50`, [ctx.orgId, id]);
  const visitsByLocation = await db.query(
    `SELECT l.name, count(*)::int AS visits FROM visits v JOIN locations l ON l.id=v.location_id WHERE v.org_id=$1 AND v.customer_id=$2 GROUP BY l.name ORDER BY visits DESC`, [ctx.orgId, id]);
  return { customer: c, stats: { ...stats, ...counts }, reservations, feedback, consents, visitsByLocation };
}

/** Staff-facing merge of two profiles (same organization only). Fully audited and non-destructive for history. */
export async function mergeCustomers(db: Db, ctx: Ctx, sourceId: string, targetId: string) {
  if (sourceId === targetId) throw badRequest("Cannot merge a profile into itself");
  const rows = await db.query<Record<string, any>>(  
    `SELECT * FROM customers WHERE org_id=$1 AND id = ANY($2) AND merged_into IS NULL AND anonymized_at IS NULL ORDER BY id FOR UPDATE`, [ctx.orgId, [sourceId, targetId]]);
  const src = rows.find((r) => r.id === sourceId), tgt = rows.find((r) => r.id === targetId);
  if (!src || !tgt) throw notFound("Customer");
  for (const t of ["reservations", "visits", "waitlist_entries", "notifications", "feedback"]) {
    await db.exec(`UPDATE ${t} SET customer_id=$1 WHERE org_id=$2 AND customer_id=$3`, [targetId, ctx.orgId, sourceId]);
  }
  await db.exec(`DELETE FROM campaign_recipients WHERE org_id=$1 AND customer_id=$2 AND campaign_id IN (SELECT campaign_id FROM campaign_recipients WHERE customer_id=$3)`, [ctx.orgId, sourceId, targetId]);
  await db.exec(`UPDATE campaign_recipients SET customer_id=$1 WHERE org_id=$2 AND customer_id=$3`, [targetId, ctx.orgId, sourceId]);
  const uniq = (a: string[], b: string[]) => [...new Set([...(a ?? []), ...(b ?? [])])];
  // the merged-away profile keeps a tombstone; free its unique identifiers first (they move to the target when empty there)
  await db.exec(`UPDATE customers SET merged_into=$1, phone=NULL, email=NULL WHERE id=$2 AND org_id=$3`, [targetId, sourceId, ctx.orgId]);
  await db.exec(
    `UPDATE customers SET phone=COALESCE(phone,$3), email=COALESCE(email,$4), vip=vip OR $5, tags=$6, dietary=$7, allergies=$8,
        birthday=COALESCE(birthday,$9), anniversary=COALESCE(anniversary,$10),
        notes = CASE WHEN $11::text IS NULL OR $11 = '' THEN notes WHEN notes IS NULL OR notes = '' THEN $11 ELSE notes || E'\\n' || $11 END,
        consent_email = consent_email OR $12, consent_sms = consent_sms OR $13, consent_whatsapp = consent_whatsapp OR $14
      WHERE id=$1 AND org_id=$2`,
    [targetId, ctx.orgId, src.phone, src.email, src.vip, uniq(tgt.tags, src.tags), uniq(tgt.dietary, src.dietary), uniq(tgt.allergies, src.allergies),
      src.birthday, src.anniversary, src.notes, !!src.consentEmail, !!src.consentSms, !!src.consentWhatsapp]);
  // the consent ledger is append-only: record inherited grants instead of rewriting history
  for (const [ch, col] of [["email", "consentEmail"], ["sms", "consentSms"], ["whatsapp", "consentWhatsapp"]] as const) {
    if (src[col] && !tgt[col]) await db.exec(`INSERT INTO consents (org_id, customer_id, channel, granted, source, note, created_by) VALUES ($1,$2,$3,true,'merge',$4,$5)`, [ctx.orgId, targetId, ch, `Inherited from merged profile ${sourceId}`, ctx.user.id]);
  }
  await audit(db, ctx, "customer.merge", "customer", targetId, { mergedFrom: sourceId, sourceName: src.name, targetName: tgt.name });
}

/** GDPR / Moroccan law 09-08 style access request: everything we hold about a guest. */
export async function exportCustomerData(db: Db, ctx: Ctx, id: string) {
  const c = await db.maybe(`SELECT * FROM customers WHERE id=$1 AND org_id=$2`, [id, ctx.orgId]);
  if (!c) throw notFound("Customer");
  const [reservations, visits, waitlist, consents, feedback, notifications] = await Promise.all([
    db.query(`SELECT code, status, party_size, start_at, source, occasion, special_requests, created_at FROM reservations WHERE org_id=$1 AND customer_id=$2 ORDER BY start_at`, [ctx.orgId, id]),
    db.query(`SELECT seated_at, left_at, party_size, spend_amount FROM visits WHERE org_id=$1 AND customer_id=$2 ORDER BY seated_at`, [ctx.orgId, id]),
    db.query(`SELECT party_size, status, joined_at FROM waitlist_entries WHERE org_id=$1 AND customer_id=$2`, [ctx.orgId, id]),
    db.query(`SELECT channel, granted, source, created_at FROM consents WHERE org_id=$1 AND customer_id=$2 ORDER BY created_at`, [ctx.orgId, id]),
    db.query(`SELECT rating, comment, submitted_at FROM feedback WHERE org_id=$1 AND customer_id=$2`, [ctx.orgId, id]),
    db.query(`SELECT template_key, channel, status, created_at FROM notifications WHERE org_id=$1 AND customer_id=$2 ORDER BY created_at`, [ctx.orgId, id]),
  ]);
  await audit(db, ctx, "customer.export", "customer", id);
  return { exportedAt: new Date().toISOString(), customer: c, reservations, visits, waitlist, consents, feedback, notifications };
}

/** Right-to-erasure workflow: irreversibly strips personal data while keeping anonymous operational statistics. */
export async function anonymizeCustomer(db: Db, ctx: Ctx | null, orgId: string, id: string, reason = "erasure_request") {
  const c = await db.maybe(`SELECT id FROM customers WHERE id=$1 AND org_id=$2 AND anonymized_at IS NULL FOR UPDATE`, [id, orgId]);
  if (!c) throw notFound("Customer");
  await db.exec(`UPDATE customers SET name='Anonymized guest', phone=NULL, email=NULL, notes=NULL, seating_preferences=NULL, tags='{}', dietary='{}', allergies='{}',
      birthday=NULL, anniversary=NULL, vip=false, consent_email=false, consent_sms=false, consent_whatsapp=false, anonymized_at=now() WHERE id=$1 AND org_id=$2`, [id, orgId]);
  await db.exec(`UPDATE reservations SET guest_name='Anonymized guest', guest_phone=NULL, guest_email=NULL, special_requests=NULL, internal_notes=NULL
      WHERE org_id=$1 AND customer_id=$2`, [orgId, id]);
  await db.exec(`UPDATE notifications SET to_address='[erased]', body='[erased]', subject=NULL WHERE org_id=$1 AND customer_id=$2`, [orgId, id]);
  await db.exec(`UPDATE waitlist_entries SET name='Anonymized guest', phone=NULL, email=NULL, notes=NULL WHERE org_id=$1 AND customer_id=$2`, [orgId, id]);
  await db.exec(`UPDATE feedback SET comment=NULL WHERE org_id=$1 AND customer_id=$2`, [orgId, id]);
  await audit(db, ctx, "customer.anonymize", "customer", id, { reason }, { orgId });
}

/** Retention policy: anonymize guests with no activity within the organization's retention period. */
export async function runRetentionSweep(db: Db, orgId: string): Promise<number> {
  const org = await db.one<{ retentionMonths: number }>(`SELECT retention_months FROM organizations WHERE id=$1`, [orgId]);
  const stale = await db.query<{ id: string }>(
    `SELECT c.id FROM customers c WHERE c.org_id=$1 AND c.anonymized_at IS NULL AND c.merged_into IS NULL
        AND c.created_at < now() - make_interval(months => $2)
        AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.customer_id=c.id AND (r.start_at > now() - make_interval(months => $2) OR r.status IN ('pending','confirmed')))
        AND NOT EXISTS (SELECT 1 FROM visits v WHERE v.customer_id=c.id AND v.seated_at > now() - make_interval(months => $2))
      LIMIT 500`, [orgId, org.retentionMonths]);
  for (const s of stale) await anonymizeCustomer(db, null, orgId, s.id, "retention_policy");
  return stale.length;
}
