import { z } from "zod";
import type { Db } from "@/lib/db";
import type { Ctx } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { badRequest } from "@/lib/errors";
import { assertSafeBaseUrl, adapterFor, type IntegrationSettings } from "./adapters";
import { enqueueEvent } from "./events";

export const settingsSchema = z.object({
  adapter: z.enum(["none", "mock", "http"]),
  baseUrl: z.string().max(500).nullable().optional(),
  shareSales: z.boolean(), shareItems: z.boolean(), shareRefunds: z.boolean(), shareKitchen: z.boolean(),
});

const DEFAULTS: IntegrationSettings = { adapter: "none", baseUrl: null, shareSales: true, shareItems: false, shareRefunds: true, shareKitchen: false };

export async function getSettings(db: Db): Promise<IntegrationSettings> {
  return (await db.maybe<IntegrationSettings>(`SELECT adapter, base_url, share_sales, share_items, share_refunds, share_kitchen FROM integration_settings`)) ?? DEFAULTS;
}

export async function putSettings(db: Db, ctx: Ctx, input: z.infer<typeof settingsSchema>) {
  let baseUrl: string | null = input.baseUrl?.trim() || null;
  if (input.adapter === "http") {
    if (!baseUrl) throw badRequest("The Fluentra endpoint URL is required", "ENDPOINT_REQUIRED");
    try { baseUrl = assertSafeBaseUrl(baseUrl); } catch (e) { throw badRequest((e as Error).message, "INVALID_ENDPOINT"); }
  }
  await db.exec(
    `INSERT INTO integration_settings (org_id, adapter, base_url, share_sales, share_items, share_refunds, share_kitchen) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (org_id) DO UPDATE SET adapter = $2, base_url = $3, share_sales = $4, share_items = $5, share_refunds = $6, share_kitchen = $7, updated_at = now()`,
    [ctx.orgId, input.adapter, baseUrl, input.shareSales, input.shareItems, input.shareRefunds, input.shareKitchen]);
  await audit(db, ctx, "integration.settings", "integration", ctx.orgId, { adapter: input.adapter, baseUrl, shareSales: input.shareSales, shareItems: input.shareItems, shareRefunds: input.shareRefunds, shareKitchen: input.shareKitchen });
  return getSettings(db);
}

/** Synchronization monitor: delivery states, backlog age and the latest errors. */
export async function syncStatus(db: Db) {
  const s = await getSettings(db);
  const adapter = adapterFor(s);
  const counts = await db.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM outbox_events GROUP BY status`);
  const oldest = await db.maybe<{ ageSec: number }>(`SELECT extract(epoch FROM now() - min(occurred_at))::int AS age_sec FROM outbox_events WHERE status = 'pending'`);
  const last = await db.maybe<{ at: Date }>(`SELECT max(delivered_at) AS at FROM outbox_events WHERE status = 'delivered'`);
  const errors = await db.query<{ id: string; type: string; status: string; attempts: number; lastError: string | null; occurredAt: Date; nextAttemptAt: Date }>(
    `SELECT id, type, status, attempts, last_error, occurred_at, next_attempt_at FROM outbox_events WHERE last_error IS NOT NULL AND status IN ('pending','dead') ORDER BY occurred_at DESC LIMIT 20`);
  const by = Object.fromEntries(counts.map((c) => [c.status, c.n]));
  return {
    settings: s,
    adapter: adapter ? { id: adapter.id, label: adapter.label, isTest: adapter.isTest } : null,
    counts: { pending: by.pending ?? 0, delivered: by.delivered ?? 0, dead: by.dead ?? 0, skipped: by.skipped ?? 0 },
    oldestPendingAgeSec: oldest?.ageSec ?? null, lastDeliveredAt: last?.at ?? null, errors,
  };
}

export const resyncSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  outletId: z.uuid().optional(),
  includeDelivered: z.boolean().default(false),
}).refine((v) => v.from <= v.to, { message: "from must be before to" });

/**
 * Manual resynchronization for a business-date range:
 *  - re-queues dead (and optionally delivered) events — the receiver de-duplicates by event id;
 *  - backfills `order.closed` events for closed orders that never produced one (e.g. integration enabled later).
 */
export async function resync(db: Db, ctx: Ctx, input: z.infer<typeof resyncSchema>) {
  const requeued = await db.exec(
    `UPDATE outbox_events SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
      WHERE status = ANY($1::text[]) AND ($4::uuid IS NULL OR outlet_id = $4)
        AND COALESCE(payload->>'businessDate', occurred_at::date::text) BETWEEN $2 AND $3`,
    [input.includeDelivered ? ["dead", "delivered"] : ["dead"], input.from, input.to, input.outletId ?? null]);
  const missing = await db.query<{ id: string; outletId: string; version: number }>(
    `SELECT o.id, o.outlet_id, o.version FROM orders o
      WHERE o.status = 'closed' AND o.business_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR o.outlet_id = $3)
        AND NOT EXISTS (SELECT 1 FROM outbox_events e WHERE e.event_key LIKE 'order.closed:' || o.id::text || ':%')`, [input.from, input.to, input.outletId ?? null]);
  for (const m of missing) {
    const o = await db.one<{ orderNo: number; businessDate: string; type: string; covers: number; openedAt: Date; closedAt: Date; grossCents: number; itemDiscountCents: number; orderDiscountCents: number; serviceChargeCents: number; taxCents: number; netSalesCents: number; totalCents: number; tipCents: number }>(
      `SELECT order_no, business_date::text, type, covers, opened_at, closed_at, gross_cents, item_discount_cents, order_discount_cents, service_charge_cents, tax_cents, net_sales_cents, total_cents, tip_cents FROM orders WHERE id = $1`, [m.id]);
    const payments = await db.query<{ id: string; method: string; amountCents: number; tipCents: number }>(`SELECT id, method, amount_cents, tip_cents FROM payments WHERE order_id = $1 AND status = 'succeeded'`, [m.id]);
    const items = await db.query<{ productId: string | null; name: string; qty: number; unitPriceCents: number; discountCents: number }>(`SELECT product_id, name, qty, unit_price_cents, discount_cents FROM order_items WHERE order_id = $1 AND status <> 'void'`, [m.id]);
    await enqueueEvent(db, { orgId: ctx.orgId, outletId: m.outletId, key: `order.closed:${m.id}:v${m.version}`, type: "order.closed", payload: {
      orderId: m.id, orderNo: o.orderNo, businessDate: o.businessDate, type: o.type, covers: o.covers, openedAt: o.openedAt, closedAt: o.closedAt, currency: ctx.org.currency, backfilled: true,
      totals: { grossCents: o.grossCents, discountCents: o.itemDiscountCents + o.orderDiscountCents, serviceChargeCents: o.serviceChargeCents, taxCents: o.taxCents, netSalesCents: o.netSalesCents, totalCents: o.totalCents, tipCents: o.tipCents },
      payments, items } });
  }
  await audit(db, ctx, "integration.resync", "integration", ctx.orgId, { ...input, requeued, backfilled: missing.length });
  return { requeued, backfilled: missing.length };
}

export async function mockInbox(db: Db, limit = 50) {
  return db.query<{ id: number; eventId: string; type: string; receivedAt: Date; payload: unknown }>(`SELECT id, event_id, type, received_at, payload FROM mock_fluentra_inbox ORDER BY id DESC LIMIT $1`, [limit]);
}
