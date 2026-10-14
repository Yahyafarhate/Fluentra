import { z } from "zod";
import { withOrg, withSystem, type Db } from "@/lib/db";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import { randomToken, sha256 } from "@/lib/ids";
import { enqueueNotification, manageToken, resolveTemplate, unsubscribeToken } from "../notifications/service";
import { CONSENT_REQUIRED_KEYS, render } from "../notifications/templates";
import type { ChannelName } from "../notifications/adapters";
import { runRetentionSweep } from "../customers/service";
import { DateTime } from "luxon";

export const TRIGGERS = ["reservation_created", "reservation_confirmed", "reservation_modified", "reservation_cancelled", "reminder_before", "visit_completed", "feedback_request", "birthday", "anniversary", "waitlist_ready"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const conditionsSchema = z.object({
  minPartySize: z.number().int().min(1).optional(),
  maxPartySize: z.number().int().min(1).optional(),
  vipOnly: z.boolean().optional(),
  sources: z.array(z.string()).max(10).optional(),
  status: z.enum(["pending", "confirmed"]).optional(),
  fallbackChannel: z.enum(["sms", "whatsapp"]).optional(),
}).strict();
export type Conditions = z.infer<typeof conditionsSchema>;

export const ruleInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  locationId: z.string().uuid().nullable().optional(),
  trigger: z.enum(TRIGGERS),
  offsetMinutes: z.number().int().min(-60 * 24 * 30).max(60 * 24 * 30).default(0),
  conditions: conditionsSchema.default({}),
  channel: z.enum(["email", "sms", "whatsapp"]),
  templateKey: z.string().min(1).max(60),
  enabled: z.boolean().default(true),
  maxAttempts: z.number().int().min(1).max(10).default(3),
});
export type RuleInput = z.infer<typeof ruleInputSchema>;

export interface RuleRow {
  id: string; orgId: string; locationId: string | null; name: string; trigger: Trigger; offsetMinutes: number;
  conditions: Conditions; channel: ChannelName; templateKey: string; enabled: boolean; isSystem: boolean; maxAttempts: number;
}

export interface EventPayload {
  type: Trigger; orgId: string; locationId: string;
  reservationId?: string; waitlistEntryId?: string; version?: string | number;
}

const SYSTEM_RULES: Array<Omit<RuleInput, "locationId">> = [
  { name: "Booking confirmation", trigger: "reservation_confirmed", offsetMinutes: 0, conditions: { fallbackChannel: "sms" }, channel: "email", templateKey: "booking_confirmation", enabled: true, maxAttempts: 3 },
  { name: "Booking request received (awaiting confirmation)", trigger: "reservation_created", offsetMinutes: 0, conditions: { status: "pending", fallbackChannel: "sms" }, channel: "email", templateKey: "booking_pending", enabled: true, maxAttempts: 3 },
  { name: "Reminder 24h before", trigger: "reminder_before", offsetMinutes: -1440, conditions: { fallbackChannel: "sms" }, channel: "email", templateKey: "booking_reminder", enabled: true, maxAttempts: 3 },
  { name: "Reminder 3h before (WhatsApp)", trigger: "reminder_before", offsetMinutes: -180, conditions: {}, channel: "whatsapp", templateKey: "booking_reminder", enabled: false, maxAttempts: 3 },
  { name: "Booking modified", trigger: "reservation_modified", offsetMinutes: 0, conditions: { fallbackChannel: "sms" }, channel: "email", templateKey: "booking_modified", enabled: true, maxAttempts: 3 },
  { name: "Booking cancelled", trigger: "reservation_cancelled", offsetMinutes: 0, conditions: { fallbackChannel: "sms" }, channel: "email", templateKey: "booking_cancelled", enabled: true, maxAttempts: 3 },
  { name: "Table ready (waitlist)", trigger: "waitlist_ready", offsetMinutes: 0, conditions: { fallbackChannel: "sms" }, channel: "email", templateKey: "waitlist_ready", enabled: true, maxAttempts: 3 },
  { name: "Thank-you after visit (needs consent)", trigger: "visit_completed", offsetMinutes: 180, conditions: {}, channel: "email", templateKey: "followup_thanks", enabled: false, maxAttempts: 3 },
  { name: "Feedback request (needs consent)", trigger: "feedback_request", offsetMinutes: 1440, conditions: {}, channel: "email", templateKey: "feedback_request", enabled: false, maxAttempts: 3 },
  { name: "Birthday greeting (needs consent)", trigger: "birthday", offsetMinutes: 0, conditions: {}, channel: "email", templateKey: "birthday_greeting", enabled: false, maxAttempts: 3 },
  { name: "Anniversary greeting (needs consent)", trigger: "anniversary", offsetMinutes: 0, conditions: {}, channel: "email", templateKey: "anniversary_greeting", enabled: false, maxAttempts: 3 },
];

export async function seedDefaultAutomations(db: Db, orgId: string) {
  for (const r of SYSTEM_RULES) {
    await db.exec(
      `INSERT INTO automation_rules (org_id, name, trigger, offset_minutes, conditions, channel, template_key, enabled, is_system, max_attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9)`,
      [orgId, r.name, r.trigger, r.offsetMinutes, JSON.stringify(r.conditions), r.channel, r.templateKey, r.enabled, r.maxAttempts]);
  }
}

const dateFmt = (d: Date, tz: string, locale: string) =>
  new Intl.DateTimeFormat(locale === "ar" ? "ar-MA-u-nu-latn" : locale === "en" ? "en-GB" : "fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: tz }).format(d);

interface ResCtx {
  id: string; locationId: string; customerId: string | null; code: string; guestName: string; guestPhone: string | null; guestEmail: string | null;
  partySize: number; status: string; source: string; isVip: boolean; startAt: Date; language: string | null; customerEmail: string | null; customerPhone: string | null;
  customerLanguage: string | null; locName: string; tz: string; address: string | null; city: string | null; policyText: string | null; locDefaultLocale: string; cancelDeadlineHours: number;
  consentEmail: boolean | null; consentSms: boolean | null; consentWhatsapp: boolean | null;
}

async function loadReservationCtx(db: Db, id: string): Promise<ResCtx | null> {
  return db.maybe<ResCtx>(
    `SELECT r.id, r.location_id, r.customer_id, r.code, r.guest_name, r.guest_phone, r.guest_email, r.party_size, r.status, r.source, r.is_vip, r.start_at, r.language,
            c.email AS customer_email, c.phone AS customer_phone, c.language AS customer_language,
            c.consent_email, c.consent_sms, c.consent_whatsapp,
            l.name AS loc_name, l.timezone AS tz, l.address, l.city, l.policy_text, l.default_locale AS loc_default_locale, l.cancel_deadline_hours
       FROM reservations r JOIN locations l ON l.id = r.location_id LEFT JOIN customers c ON c.id = r.customer_id WHERE r.id = $1`, [id]);
}

function conditionsMatch(cond: Conditions, r: { partySize: number; isVip: boolean; source: string; status: string }): boolean {
  if (cond.minPartySize && r.partySize < cond.minPartySize) return false;
  if (cond.maxPartySize && r.partySize > cond.maxPartySize) return false;
  if (cond.vipOnly && !r.isVip) return false;
  if (cond.sources?.length && !cond.sources.includes(r.source)) return false;
  if (cond.status && r.status !== cond.status) return false;
  return true;
}

interface Target { channel: ChannelName; address: string }
function pickTarget(rule: Pick<RuleRow, "channel" | "conditions">, c: { email: string | null; phone: string | null }): Target | null {
  const addr = (ch: ChannelName) => (ch === "email" ? c.email : c.phone);
  const a = addr(rule.channel);
  if (a) return { channel: rule.channel, address: a };
  const fb = rule.conditions.fallbackChannel;
  if (fb && addr(fb)) return { channel: fb, address: addr(fb)! };
  return null;
}

async function createRun(db: Db, rule: RuleRow, entityType: string, entityId: string | null, customerId: string | null, key: string): Promise<string | null> {
  const r = await db.maybe<{ id: string }>(
    `INSERT INTO automation_runs (org_id, rule_id, entity_type, entity_id, customer_id, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (org_id, idempotency_key) DO NOTHING RETURNING id`, [rule.orgId, rule.id, entityType, entityId, customerId, key]);
  return r?.id ?? null;
}
const finishRun = async (db: Db, runId: string, status: string, detail: string): Promise<void> => {
  await db.exec(`UPDATE automation_runs SET status=$2, detail=$3, executed_at=now() WHERE id=$1`, [runId, status, detail]);
};

async function consentOk(db: Db, orgId: string, customerId: string | null, channel: ChannelName, templateKey: string): Promise<boolean> {
  if (!CONSENT_REQUIRED_KEYS.has(templateKey)) return true;
  if (!customerId) return false;
  const col = channel === "email" ? "consent_email" : channel === "sms" ? "consent_sms" : "consent_whatsapp";
  const c = await db.maybe<{ ok: boolean }>(`SELECT ${col} AS ok FROM customers WHERE id=$1 AND org_id=$2 AND anonymized_at IS NULL`, [customerId, orgId]);
  return !!c?.ok;
}

/** Evaluate a rule against a reservation and queue the resulting message (idempotent per rule + reservation + version). */
async function fireReservationRule(db: Db, rule: RuleRow, r: ResCtx, version: string, extra: Record<string, string> = {}): Promise<void> {
  if (!conditionsMatch(rule.conditions, r)) return;
  const key = `${rule.id}:res:${r.id}:${version}`;
  const runId = await createRun(db, rule, "reservation", r.id, r.customerId, key);
  if (!runId) return; // already handled
  const target = pickTarget(rule, { email: r.guestEmail ?? r.customerEmail, phone: r.guestPhone ?? r.customerPhone });
  if (!target) return finishRun(db, runId, "skipped", "No contact address for this guest");
  if (!(await consentOk(db, rule.orgId, r.customerId, target.channel, rule.templateKey))) return finishRun(db, runId, "skipped", "Guest has not consented to this kind of message");
  const locale = r.language ?? r.customerLanguage ?? r.locDefaultLocale ?? "fr";
  const tpl = await resolveTemplate(db, rule.orgId, rule.templateKey, target.channel, locale);
  const vars = {
    guest_name: r.guestName, restaurant: r.locName, date: dateFmt(r.startAt, r.tz, locale), time: DateTime.fromJSDate(r.startAt, { zone: r.tz }).toFormat("HH:mm"),
    party_size: r.partySize, code: r.code, manage_link: `${env.appUrl}/r/${manageToken(r.id)}`, address: [r.address, r.city].filter(Boolean).join(", "),
    policy: r.policyText ?? "", unsubscribe_link: r.customerId ? `${env.appUrl}/u/${unsubscribeToken(r.customerId, target.channel)}` : "", ...extra,
  };
  const nid = await enqueueNotification(db, {
    orgId: rule.orgId, locationId: r.locationId, customerId: r.customerId, reservationId: r.id, templateKey: rule.templateKey, channel: target.channel,
    to: target.address, locale, subject: target.channel === "email" ? render(tpl.subject, vars) : null, body: render(tpl.body, vars), idempotencyKey: `auto:${key}`,
  });
  await db.exec(`UPDATE automation_runs SET notification_id=$2, status='queued', detail='Queued for delivery' WHERE id=$1`, [runId, nid]);
}

async function rulesFor(db: Db, orgId: string, trigger: Trigger, locationId: string | null, immediate: boolean): Promise<RuleRow[]> {
  const planOk = await db.one<{ custom: boolean }>(`SELECT 'automations' = ANY(p.features) AS custom FROM organizations o JOIN plans p ON p.id=o.plan_id WHERE o.id=$1`, [orgId]);
  return db.query<RuleRow>(
    `SELECT * FROM automation_rules WHERE org_id=$1 AND trigger=$2 AND enabled AND ($3::uuid IS NULL OR location_id IS NULL OR location_id=$3)
       AND ($4 OR is_system) ${immediate ? "AND offset_minutes = 0" : ""}`, [orgId, trigger, locationId, planOk.custom]);
}

/** Immediate (event-driven) automations. Runs inside the caller's transaction so messages are queued atomically with the change. */
export async function dispatchEvent(db: Db, ev: EventPayload): Promise<void> {
  const rules = await rulesFor(db, ev.orgId, ev.type, ev.locationId, true);
  if (!rules.length) return;
  if (ev.waitlistEntryId) {
    const w = await db.maybe<{ id: string; name: string; phone: string | null; email: string | null; partySize: number; customerId: string | null; quotedWaitMin: number | null; locName: string; defaultLocale: string }>(
      `SELECT w.id, w.name, w.phone, w.email, w.party_size, w.customer_id, w.quoted_wait_min, l.name AS loc_name, l.default_locale
         FROM waitlist_entries w JOIN locations l ON l.id=w.location_id WHERE w.id=$1`, [ev.waitlistEntryId]);
    if (!w) return;
    for (const rule of rules) {
      const runId = await createRun(db, rule, "waitlist", w.id, w.customerId, `${rule.id}:wl:${w.id}:${ev.version ?? 0}`);
      if (!runId) continue;
      const target = pickTarget(rule, { email: w.email, phone: w.phone });
      if (!target) { await finishRun(db, runId, "skipped", "No contact address for this guest"); continue; }
      const tpl = await resolveTemplate(db, ev.orgId, rule.templateKey, target.channel, w.defaultLocale);
      const vars = { guest_name: w.name, restaurant: w.locName, party_size: w.partySize, wait_minutes: w.quotedWaitMin ?? "" };
      const nid = await enqueueNotification(db, { orgId: ev.orgId, locationId: ev.locationId, customerId: w.customerId, templateKey: rule.templateKey, channel: target.channel,
        to: target.address, locale: w.defaultLocale, subject: target.channel === "email" ? render(tpl.subject, vars) : null, body: render(tpl.body, vars), idempotencyKey: `auto:${rule.id}:wl:${w.id}:${ev.version ?? 0}` });
      await db.exec(`UPDATE automation_runs SET notification_id=$2, status='queued', detail='Queued for delivery' WHERE id=$1`, [runId, nid]);
    }
    return;
  }
  if (!ev.reservationId) return;
  const r = await loadReservationCtx(db, ev.reservationId);
  if (!r) return;
  for (const rule of rules) await fireReservationRule(db, rule, r, String(ev.version ?? 0));
}

/** Time-based automations (reminders, follow-ups, feedback, birthdays). Safe to call repeatedly: runs are idempotent. */
export async function runScheduledAutomations(): Promise<{ queued: number }> {
  const orgs = await withSystem((db) => db.query<{ id: string }>(`SELECT id FROM organizations WHERE status IN ('trial','active','past_due')`));
  let queued = 0;
  for (const o of orgs) {
    try {
      queued += await withOrg(o.id, (db) => scanOrg(db, o.id));
    } catch (e) { log.error("scheduled automation scan failed", { orgId: o.id, error: String(e) }); }
  }
  return { queued };
}

async function scanOrg(db: Db, orgId: string): Promise<number> {
  const rules = await db.query<RuleRow>(`SELECT * FROM automation_rules WHERE org_id=$1 AND enabled AND trigger IN ('reminder_before','visit_completed','feedback_request','birthday','anniversary')`, [orgId]);
  const planOk = await db.one<{ custom: boolean }>(`SELECT 'automations' = ANY(p.features) AS custom FROM organizations o JOIN plans p ON p.id=o.plan_id WHERE o.id=$1`, [orgId]);
  let n = 0;
  for (const rule of rules) {
    if (!rule.isSystem && !planOk.custom) continue;
    if (rule.trigger === "reminder_before") {
      const ids = await db.query<{ id: string }>(
        `SELECT id FROM reservations WHERE org_id=$1 AND ($2::uuid IS NULL OR location_id=$2) AND status='confirmed'
            AND start_at > now() AND start_at + make_interval(mins => $3) <= now() AND start_at + make_interval(mins => $3) > now() - interval '12 hours' LIMIT 200`,
        [orgId, rule.locationId, rule.offsetMinutes]);
      for (const { id } of ids) { const r = await loadReservationCtx(db, id); if (r) { await fireReservationRule(db, rule, r, "t"); n++; } }
    } else if (rule.trigger === "visit_completed" || rule.trigger === "feedback_request") {
      const ids = await db.query<{ id: string }>(
        `SELECT id FROM reservations WHERE org_id=$1 AND ($2::uuid IS NULL OR location_id=$2) AND status='completed'
            AND completed_at + make_interval(mins => $3) <= now() AND completed_at > now() - interval '7 days' LIMIT 200`, [orgId, rule.locationId, rule.offsetMinutes]);
      for (const { id } of ids) {
        const r = await loadReservationCtx(db, id);
        if (!r) continue;
        let extra: Record<string, string> = {};
        if (rule.trigger === "feedback_request" && r.customerId) {
          const token = randomToken(24);
          const v = await db.maybe<{ id: string }>(`SELECT id FROM visits WHERE reservation_id=$1`, [r.id]);
          await db.exec(`INSERT INTO feedback (org_id, location_id, customer_id, visit_id, token_hash) SELECT $1,$2,$3,$4,$5
                          WHERE NOT EXISTS (SELECT 1 FROM feedback WHERE visit_id=$4)`, [orgId, r.locationId, r.customerId, v?.id ?? null, sha256(token)]);
          extra = { feedback_link: `${env.appUrl}/feedback/${token}` };
        }
        await fireReservationRule(db, rule, r, "t", extra); n++;
      }
    } else {
      const col = rule.trigger === "birthday" ? "birthday" : "anniversary";
      const offsetDays = Math.round(rule.offsetMinutes / 1440);
      const customers = await db.query<{ id: string; name: string; email: string | null; phone: string | null; language: string | null; year: number; locName: string | null; locLocale: string | null }>(
        `SELECT c.id, c.name, c.email, c.phone, c.language, extract(year from current_date)::int AS year,
                (SELECT name FROM locations WHERE org_id=$1 AND status='active' ORDER BY created_at LIMIT 1) AS loc_name,
                (SELECT default_locale FROM locations WHERE org_id=$1 AND status='active' ORDER BY created_at LIMIT 1) AS loc_locale
           FROM customers c WHERE c.org_id=$1 AND c.${col} IS NOT NULL AND c.anonymized_at IS NULL AND c.merged_into IS NULL
            AND to_char(c.${col}, 'MM-DD') = to_char(current_date + $2::int, 'MM-DD') LIMIT 500`, [orgId, offsetDays]);
      for (const c of customers) {
        const runKey = `${rule.id}:cust:${c.id}:${c.year}`;
        const runId = await createRun(db, rule, "customer", c.id, c.id, runKey);
        if (!runId) continue;
        const target = pickTarget(rule, { email: c.email, phone: c.phone });
        if (!target) { await finishRun(db, runId, "skipped", "No contact address"); continue; }
        if (!(await consentOk(db, orgId, c.id, target.channel, rule.templateKey))) { await finishRun(db, runId, "skipped", "Guest has not consented to this kind of message"); continue; }
        const locale = c.language ?? c.locLocale ?? "fr";
        const tpl = await resolveTemplate(db, orgId, rule.templateKey, target.channel, locale);
        const vars = { guest_name: c.name, restaurant: c.locName ?? "", unsubscribe_link: `${env.appUrl}/u/${unsubscribeToken(c.id, target.channel)}` };
        const nid = await enqueueNotification(db, { orgId, customerId: c.id, templateKey: rule.templateKey, channel: target.channel, to: target.address, locale,
          subject: target.channel === "email" ? render(tpl.subject, vars) : null, body: render(tpl.body, vars), idempotencyKey: `auto:${runKey}` });
        await db.exec(`UPDATE automation_runs SET notification_id=$2, status='queued', detail='Queued for delivery' WHERE id=$1`, [runId, nid]);
        n++;
      }
    }
  }
  return n;
}

export async function runRetentionForAll() {
  const orgs = await withSystem((db) => db.query<{ id: string }>(`SELECT id FROM organizations WHERE status <> 'cancelled'`));
  for (const o of orgs) await withOrg(o.id, (db) => runRetentionSweep(db, o.id));
}

/** Release expired temporary holds and stale rate-limit windows; called from the periodic tick. */
export async function housekeeping() {
  await withSystem(async (db) => {
    await db.exec(`DELETE FROM slot_holds WHERE expires_at < now() - interval '1 hour'`);
    await db.exec(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`);
    await db.exec(`DELETE FROM sessions WHERE expires_at < now()`);
    await db.exec(`DELETE FROM password_resets WHERE expires_at < now() - interval '1 day'`);
    await db.exec(`DELETE FROM jobs WHERE status='done' AND finished_at < now() - interval '7 days'`);
  });
}

/** Called by the scheduler: enqueues the periodic scan, scheduled campaigns and daily retention. */
export async function scheduleTick() {
  await withSystem(async (db) => {
    const bucket = Math.floor(Date.now() / 60_000);
    await db.exec(`INSERT INTO jobs (type, idempotency_key, max_attempts) VALUES ('tick', $1, 1) ON CONFLICT DO NOTHING`, [`tick:${bucket}`]);
    const day = new Date().toISOString().slice(0, 10);
    await db.exec(`INSERT INTO jobs (type, idempotency_key, max_attempts) VALUES ('retention_sweep', $1, 2) ON CONFLICT DO NOTHING`, [`retention:${day}`]);
    const due = await db.query<{ id: string; orgId: string }>(`UPDATE campaigns SET status='sending' WHERE status='scheduled' AND scheduled_at <= now() RETURNING id, org_id`);
    for (const c of due) await db.exec(`INSERT INTO jobs (org_id, type, payload, idempotency_key) VALUES ($3, 'send_campaign', $1, $2) ON CONFLICT DO NOTHING`, [JSON.stringify({ orgId: c.orgId, campaignId: c.id }), `campaign:${c.id}`, c.orgId]);
  });
  await housekeeping();
}

