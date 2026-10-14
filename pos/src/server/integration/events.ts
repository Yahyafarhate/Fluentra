import type { Db } from "@/lib/db";

/**
 * Versioned event contract published to Fluentra (see docs/FLUENTRA_INTEGRATION.md).
 * Events carry no guest personal data. `eventKey` makes enqueueing idempotent at the source.
 */
export const EVENT_VERSION = 1;
export type EventType =
  | "order.closed" | "order.reopened" | "order.voided"
  | "payment.recorded" | "refund.recorded"
  | "item.voided" | "cash_session.closed" | "day.closed" | "kitchen.delay";

export async function enqueueEvent(db: Db, e: { orgId: string; outletId: string | null; key: string; type: EventType; payload: Record<string, unknown> }) {
  await db.exec(
    `INSERT INTO outbox_events (org_id, outlet_id, event_key, type, version, payload) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (org_id, event_key) DO NOTHING`,
    [e.orgId, e.outletId, e.key, e.type, EVENT_VERSION, JSON.stringify(e.payload)]);
  // best-effort immediate delivery after the business transaction commits; the cron tick is the safety net
  db.afterCommit(() => { void import("./dispatcher").then((m) => m.kickOutbox()).catch(() => undefined); });
}
