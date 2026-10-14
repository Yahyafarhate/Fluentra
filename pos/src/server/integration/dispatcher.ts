import { withSystem, withOrg } from "@/lib/db";
import { log } from "@/lib/logger";
import { env } from "@/lib/env";
import { adapterFor, type IntegrationSettings, type OutboundEvent } from "./adapters";

const MAX_ATTEMPTS = 12;
export const backoffSec = (attempt: number) => Math.min(30 * 2 ** (attempt - 1), 3600);

interface Claimed { id: string; orgId: string; outletId: string | null; type: string; version: number; payload: Record<string, unknown>; occurredAt: Date; attempts: number; fluentraLocationId: string | null }

/** Data minimization: decide per event type what the organization allows to leave the POS. */
export function applySharing(type: string, payload: Record<string, unknown>, s: IntegrationSettings): Record<string, unknown> | null {
  switch (type) {
    case "order.closed": {
      if (!s.shareSales) return null;
      if (s.shareItems) return payload;
      const { items: _items, ...rest } = payload; void _items;
      return rest;
    }
    case "order.reopened": case "order.voided": case "payment.recorded": case "cash_session.closed": case "day.closed": return s.shareSales ? payload : null;
    case "refund.recorded": case "item.voided": return s.shareRefunds ? payload : null;
    case "kitchen.delay": return s.shareKitchen ? payload : null;
    default: return null;
  }
}

async function loadSettings(orgId: string): Promise<IntegrationSettings> {
  const s = await withOrg(orgId, (db) => db.maybe<IntegrationSettings>(`SELECT adapter, base_url, share_sales, share_items, share_refunds, share_kitchen FROM integration_settings WHERE org_id = $1`, [orgId]));
  return s ?? { adapter: "none", baseUrl: null, shareSales: true, shareItems: false, shareRefunds: true, shareKitchen: false };
}

/** Claim due events with a lease (SKIP LOCKED), deliver them outside any transaction, then record the outcome. */
export async function runOutbox(limit = 50): Promise<{ delivered: number; failed: number; dead: number; skipped: number }> {
  const claimed = await withSystem((db) => db.query<Claimed>(
    `UPDATE outbox_events e SET attempts = attempts + 1, next_attempt_at = now() + interval '2 minutes'
      WHERE e.id IN (
        SELECT x.id FROM outbox_events x
          JOIN integration_settings s ON s.org_id = x.org_id AND s.adapter <> 'none'
         WHERE x.status = 'pending' AND x.next_attempt_at <= now() ORDER BY x.seq LIMIT $1 FOR UPDATE OF x SKIP LOCKED)
      RETURNING e.id, e.org_id, e.outlet_id, e.type, e.version, e.payload, e.occurred_at, e.attempts,
        (SELECT fluentra_location_id FROM outlets o WHERE o.id = e.outlet_id) AS fluentra_location_id`, [limit]));
  const out = { delivered: 0, failed: 0, dead: 0, skipped: 0 };
  const settingsCache = new Map<string, IntegrationSettings>();
  for (const ev of claimed) {
    let settings = settingsCache.get(ev.orgId);
    if (!settings) { settings = await loadSettings(ev.orgId); settingsCache.set(ev.orgId, settings); }
    const adapter = adapterFor(settings);
    const data = applySharing(ev.type, ev.payload, settings);
    try {
      if (!adapter) { await release(ev.id, ev.attempts - 1); continue; }
      if (data === null) {
        await withSystem((db) => db.exec(`UPDATE outbox_events SET status = 'skipped', last_error = 'Not shared (sharing permissions)' WHERE id = $1`, [ev.id]));
        out.skipped++; continue;
      }
      const outbound: OutboundEvent = { eventId: ev.id, type: ev.type, version: ev.version, occurredAt: ev.occurredAt.toISOString(), orgId: ev.orgId, outlet: { id: ev.outletId, fluentraLocationId: ev.fluentraLocationId }, data };
      const r = await adapter.publish(outbound, settings);
      if (r.ok) {
        await withSystem((db) => db.exec(`UPDATE outbox_events SET status = 'delivered', delivered_at = now(), last_error = NULL WHERE id = $1`, [ev.id]));
        out.delivered++;
      } else if (r.retryable === false || ev.attempts >= MAX_ATTEMPTS) {
        await withSystem((db) => db.exec(`UPDATE outbox_events SET status = 'dead', last_error = $2 WHERE id = $1`, [ev.id, r.error ?? "failed"]));
        out.dead++;
      } else {
        await withSystem((db) => db.exec(`UPDATE outbox_events SET last_error = $2, next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1`, [ev.id, r.error ?? "failed", backoffSec(ev.attempts)]));
        out.failed++;
      }
    } catch (e) {
      log.error("outbox delivery error", { eventId: ev.id, error: String((e as Error).message).slice(0, 200) });
      await withSystem((db) => db.exec(`UPDATE outbox_events SET last_error = $2, next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1`, [ev.id, String((e as Error).message).slice(0, 200), backoffSec(ev.attempts)])).catch(() => undefined);
      out.failed++;
    }
  }
  return out;
}

async function release(id: string, attempts: number) {
  await withSystem((db) => db.exec(`UPDATE outbox_events SET attempts = $2, next_attempt_at = now() WHERE id = $1`, [id, attempts]));
}

let kicking = false;
/** Fire-and-forget delivery after a commit. Skipped in tests (they call runOutbox explicitly) and on serverless (cron tick). */
export function kickOutbox() {
  if (env.isTest || env.serverless || kicking) return;
  kicking = true;
  setTimeout(() => { runOutbox(20).catch((e) => log.error("outbox kick failed", { error: String(e) })).finally(() => { kicking = false; }); }, 50);
}

export async function purgeOldEvents() {
  return withSystem((db) => db.exec(`DELETE FROM outbox_events WHERE status IN ('delivered','skipped') AND occurred_at < now() - interval '30 days'`));
}
