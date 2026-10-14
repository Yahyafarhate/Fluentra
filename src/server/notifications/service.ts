import { withOrg, withSystem, type Db } from "@/lib/db";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import { hmac } from "@/lib/ids";
import { adapterFor, type ChannelName } from "./adapters";
import { CONSENT_REQUIRED_KEYS, DEFAULT_TEMPLATES, render, type Locale } from "./templates";
import { enqueueJob } from "./jobs";

export interface EnqueueInput {
  orgId: string; locationId?: string | null; customerId?: string | null; reservationId?: string | null; campaignId?: string | null;
  templateKey: string; channel: ChannelName; to: string; locale: string; subject?: string | null; body: string;
  idempotencyKey: string; scheduledAt?: Date;
}

/** Inserts the notification (once per idempotency key) and schedules its delivery job. Returns null for duplicates. */
export async function enqueueNotification(db: Db, i: EnqueueInput): Promise<string | null> {
  const row = await db.maybe<{ id: string }>(
    `INSERT INTO notifications (org_id, location_id, customer_id, reservation_id, campaign_id, template_key, channel, to_address, locale, subject, body, idempotency_key, scheduled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (org_id, idempotency_key) DO NOTHING RETURNING id`,
    [i.orgId, i.locationId ?? null, i.customerId ?? null, i.reservationId ?? null, i.campaignId ?? null, i.templateKey, i.channel, i.to, i.locale, i.subject ?? null, i.body, i.idempotencyKey, i.scheduledAt ?? new Date()]);
  if (!row) return null;
  await enqueueJob(db, "send_notification", { orgId: i.orgId, notificationId: row.id }, { runAt: i.scheduledAt, idempotencyKey: `notif:${row.id}`, maxAttempts: 4 });
  return row.id;
}

/** Org template override (if any) else the built-in default. */
export async function resolveTemplate(db: Db, orgId: string, key: string, channel: ChannelName, locale: string): Promise<{ subject: string; body: string }> {
  const loc = (["fr", "en", "ar"].includes(locale) ? locale : "fr") as Locale;
  const o = await db.maybe<{ subject: string | null; body: string }>(
    `SELECT subject, body FROM notification_templates WHERE org_id=$1 AND key=$2 AND channel=$3 AND locale=$4 AND active`, [orgId, key, channel, loc]);
  if (o) return { subject: o.subject ?? "", body: o.body };
  const base = (DEFAULT_TEMPLATES as Record<string, Record<Locale, { subject: string; body: string }>>)[key]?.[loc];
  return base ?? { subject: key, body: "" };
}

export const unsubscribeToken = (customerId: string, channel: string) => `${customerId}.${channel}.${hmac(env.appSecret, `unsub:${customerId}:${channel}`).slice(0, 32)}`;
export function verifyUnsubscribeToken(token: string): { customerId: string; channel: ChannelName } | null {
  const [customerId, channel, sig] = token.split(".");
  if (!customerId || !["email", "sms", "whatsapp"].includes(channel ?? "") || !sig) return null;
  return sig === hmac(env.appSecret, `unsub:${customerId}:${channel}`).slice(0, 32) ? { customerId, channel: channel as ChannelName } : null;
}
export const manageToken = (reservationId: string) => `${reservationId}.${hmac(env.appSecret, `manage:${reservationId}`).slice(0, 32)}`;
export function verifyManageToken(token: string): string | null {
  const [id, sig] = token.split(".");
  if (!id || !sig) return null;
  return sig === hmac(env.appSecret, `manage:${id}`).slice(0, 32) ? id : null;
}

const nextBackoffSec = (attempt: number) => Math.min(1800, 60 * 2 ** (attempt - 1));

/**
 * Deliver one notification. Idempotent: only a `queued` row is processed, and the row is claimed with FOR UPDATE SKIP LOCKED
 * so concurrent job retries cannot send the same message twice.
 */
export async function deliverNotification(orgId: string, notificationId: string): Promise<{ status: string }> {
  const claim = await withOrg(orgId, async (db) => {
    const n = await db.maybe<{ id: string; channel: ChannelName; toAddress: string; subject: string | null; body: string; templateKey: string; customerId: string | null; attempts: number }>(
      `SELECT id, channel, to_address, subject, body, template_key, customer_id, attempts FROM notifications
        WHERE id=$1 AND status='queued' FOR UPDATE SKIP LOCKED`, [notificationId]);
    if (!n) return null;
    // consent may have been withdrawn between scheduling and sending
    if (CONSENT_REQUIRED_KEYS.has(n.templateKey) && n.customerId) {
      const col = n.channel === "email" ? "consent_email" : n.channel === "sms" ? "consent_sms" : "consent_whatsapp";
      const c = await db.maybe<{ ok: boolean }>(`SELECT ${col} AS ok FROM customers WHERE id=$1 AND org_id=$2`, [n.customerId, orgId]);
      if (!c?.ok) {
        await db.exec(`UPDATE notifications SET status='skipped', error='Recipient has no (or withdrew) consent for this channel' WHERE id=$1`, [n.id]);
        await markRun(db, n.id, "skipped", "No consent");
        return null;
      }
    }
    return n;
  });
  if (!claim) return { status: "skipped" };

  const adapter = adapterFor(claim.channel);
  if (!adapter.isConfigured()) {
    const sim = env.simulateNotifications;
    await withOrg(orgId, async (db) => {
      await db.exec(
        `UPDATE notifications SET status=$2, provider=$3, error=$4, attempts=attempts+1, sent_at=CASE WHEN $2='simulated' THEN now() END WHERE id=$1`,
        [claim.id, sim ? "simulated" : "skipped", sim ? "simulator" : adapter.provider, sim ? null : "No provider connected for this channel"]);
      await markRun(db, claim.id, sim ? "simulated" : "skipped", sim ? "Simulated (development mode) — nothing was sent" : "No provider connected");
    });
    return { status: sim ? "simulated" : "skipped" };
  }

  const res = await adapter.send({ to: claim.toAddress, subject: claim.subject, body: claim.body, idempotencyKey: claim.id });
  return withOrg(orgId, async (db) => {
    const attempts = claim.attempts + 1;
    if (res.ok) {
      await db.exec(`UPDATE notifications SET status='sent', provider=$2, provider_message_id=$3, attempts=$4, sent_at=now(), error=NULL WHERE id=$1`, [claim.id, adapter.provider, res.providerMessageId ?? null, attempts]);
      await markRun(db, claim.id, "sent", null);
      return { status: "sent" };
    }
    const rule = await db.maybe<{ maxAttempts: number }>(`SELECT r.max_attempts FROM automation_runs ar JOIN automation_rules r ON r.id = ar.rule_id WHERE ar.notification_id=$1`, [claim.id]);
    const max = rule?.maxAttempts ?? 3;
    if (res.retryable && attempts < max) {
      // stays queued; a delayed job retries it
      await db.exec(`UPDATE notifications SET attempts=$2, error=$3, provider=$4 WHERE id=$1`, [claim.id, attempts, res.error ?? "send failed", adapter.provider]);
      await enqueueJob(db, "send_notification", { orgId, notificationId: claim.id }, { runAt: new Date(Date.now() + nextBackoffSec(attempts) * 1000), idempotencyKey: `notif:${claim.id}:retry${attempts}`, maxAttempts: 2 });
      await markRun(db, claim.id, "queued", `Attempt ${attempts} failed, retrying: ${res.error}`);
      return { status: "retrying" };
    }
    await db.exec(`UPDATE notifications SET status='failed', attempts=$2, error=$3, provider=$4 WHERE id=$1`, [claim.id, attempts, res.error ?? "send failed", adapter.provider]);
    await markRun(db, claim.id, "failed", res.error ?? "send failed");
    log.warn("notification failed permanently", { notificationId: claim.id, channel: claim.channel });
    return { status: "failed" };
  });
}

async function markRun(db: Db, notificationId: string, status: "queued" | "sent" | "simulated" | "skipped" | "failed", detail: string | null) {
  await db.exec(`UPDATE automation_runs SET status=$2, detail=$3, executed_at=now(), attempts=attempts+1 WHERE notification_id=$1`, [notificationId, status, detail]);
  await db.exec(`UPDATE campaign_recipients SET status=$2 WHERE notification_id=$1 AND $2 <> 'queued'`, [notificationId, status]);
}

/** Provider webhooks (delivery receipts / engagement). Only these may set delivered/opened/clicked. */
export async function applyDeliveryEvent(e: { provider: string; providerMessageId: string; event: "delivered" | "failed" | "opened" | "clicked"; error?: string }) {
  await withSystem(async (db) => {
    const n = await db.maybe<{ id: string; orgId: string }>(`SELECT id, org_id FROM notifications WHERE provider=$1 AND provider_message_id=$2`, [e.provider, e.providerMessageId]);
    if (!n) return;
    if (e.event === "delivered") await db.exec(`UPDATE notifications SET status='delivered', delivered_at=COALESCE(delivered_at, now()) WHERE id=$1`, [n.id]);
    else if (e.event === "failed") await db.exec(`UPDATE notifications SET status='failed', error=$2 WHERE id=$1`, [n.id, e.error ?? "provider reported failure"]);
    else if (e.event === "opened") await db.exec(`UPDATE notifications SET opened_at=COALESCE(opened_at, now()) WHERE id=$1`, [n.id]);
    else await db.exec(`UPDATE notifications SET clicked_at=COALESCE(clicked_at, now()) WHERE id=$1`, [n.id]);
    await db.exec(`UPDATE campaign_recipients SET status=(SELECT status FROM notifications WHERE id=$1) WHERE notification_id=$1`, [n.id]);
  });
}

export { render };
