import { z } from "zod";
import type { Db } from "@/lib/db";
import { assertOutletAccess, type Ctx } from "@/lib/auth";
import { conflict } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { listOutlets, loadOutlet } from "@/server/outlets/service";
import { enqueueEvent } from "@/server/integration/events";

export const rangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), outletId: z.uuid().optional(),
}).refine((v) => v.from <= v.to, { message: "from must not be after to" }).refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 400, { message: "Range too long (max 400 days)" });
export type Range = z.infer<typeof rangeSchema>;

/** Outlets the caller may report on (all accessible ones, or a single requested outlet). */
async function scope(db: Db, ctx: Ctx, outletId?: string): Promise<string[]> {
  if (outletId) { await loadOutlet(db, ctx, outletId); return [outletId]; }
  return (await listOutlets(db, ctx)).map((o) => o.id);
}

const shiftDays = (d: string, n: number) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;

/**
 * Sales definitions (see docs/METRICS.md). All figures come from the immutable snapshot of CLOSED orders,
 * grouped by the business date of the order; refunds are grouped by the business date on which they were issued.
 *  gross       = Σ qty × unit price, before discounts
 *  discounts   = item discounts + order discounts
 *  net sales   = items after discounts, excluding tax and service charge
 *  total       = what guests were billed (items after discounts + service charge [+ tax if prices exclude tax]); tips excluded
 */
export async function salesSummary(db: Db, ctx: Ctx, r: Range) {
  const outlets = await scope(db, ctx, r.outletId);
  const cur = await period(db, outlets, r.from, r.to);
  const span = daysBetween(r.from, r.to);
  const prev = await period(db, outlets, shiftDays(r.from, -span), shiftDays(r.from, -1));
  const delta = (a: number, b: number) => (b === 0 ? null : Math.round(((a - b) / b) * 1000) / 10);
  return { range: r, current: cur, previous: { from: shiftDays(r.from, -span), to: shiftDays(r.from, -1), ...prev }, changePct: { totalCents: delta(cur.totalCents, prev.totalCents), orders: delta(cur.orders, prev.orders), covers: delta(cur.covers, prev.covers) } };
}

async function period(db: Db, outlets: string[], from: string, to: string) {
  const s = await db.one<{ orders: number; covers: number; gross: number; itemDisc: number; orderDisc: number; service: number; tax: number; net: number; total: number; tips: number }>(
    `SELECT count(*)::int AS orders, COALESCE(sum(covers),0)::int AS covers, COALESCE(sum(gross_cents),0)::int AS gross, COALESCE(sum(item_discount_cents),0)::int AS item_disc,
            COALESCE(sum(order_discount_cents),0)::int AS order_disc, COALESCE(sum(service_charge_cents),0)::int AS service, COALESCE(sum(tax_cents),0)::int AS tax,
            COALESCE(sum(net_sales_cents),0)::int AS net, COALESCE(sum(total_cents),0)::int AS total, COALESCE(sum(tip_cents),0)::int AS tips
       FROM orders WHERE status = 'closed' AND outlet_id = ANY($1::uuid[]) AND business_date BETWEEN $2 AND $3`, [outlets, from, to]);
  const refunds = await db.one<{ n: number; amount: number }>(`SELECT count(*)::int AS n, COALESCE(sum(amount_cents),0)::int AS amount FROM refunds WHERE status = 'succeeded' AND outlet_id = ANY($1::uuid[]) AND business_date BETWEEN $2 AND $3`, [outlets, from, to]);
  const voids = await db.one<{ items: number; itemAmount: number; orders: number }>(
    `SELECT (SELECT count(*) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.status = 'void' AND i.fired_at IS NOT NULL AND o.outlet_id = ANY($1::uuid[]) AND o.business_date BETWEEN $2 AND $3)::int AS items,
            (SELECT COALESCE(sum(i.unit_price_cents * i.qty),0) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.status = 'void' AND i.fired_at IS NOT NULL AND o.outlet_id = ANY($1::uuid[]) AND o.business_date BETWEEN $2 AND $3)::int AS item_amount,
            (SELECT count(*) FROM orders WHERE status = 'void' AND outlet_id = ANY($1::uuid[]) AND business_date BETWEEN $2 AND $3)::int AS orders`, [outlets, from, to]);
  return {
    orders: s.orders, covers: s.covers, grossCents: s.gross, discountCents: s.itemDisc + s.orderDisc, itemDiscountCents: s.itemDisc, orderDiscountCents: s.orderDisc,
    serviceChargeCents: s.service, taxCents: s.tax, netSalesCents: s.net, totalCents: s.total, tipsCents: s.tips,
    avgCheckCents: s.orders ? Math.round(s.total / s.orders) : 0, avgPerCoverCents: s.covers ? Math.round(s.total / s.covers) : 0,
    refunds: { count: refunds.n, amountCents: refunds.amount }, netOfRefundsCents: s.total - refunds.amount,
    voids: { itemCount: voids.items, itemAmountCents: voids.itemAmount, orderCount: voids.orders },
  };
}

export async function salesByDay(db: Db, ctx: Ctx, r: Range) {
  const outlets = await scope(db, ctx, r.outletId);
  return db.query<{ date: string; orders: number; covers: number; totalCents: number; netSalesCents: number }>(
    `SELECT business_date::text AS date, count(*)::int AS orders, COALESCE(sum(covers),0)::int AS covers, COALESCE(sum(total_cents),0)::int AS total_cents, COALESCE(sum(net_sales_cents),0)::int AS net_sales_cents
       FROM orders WHERE status = 'closed' AND outlet_id = ANY($1::uuid[]) AND business_date BETWEEN $2 AND $3 GROUP BY business_date ORDER BY business_date`, [outlets, r.from, r.to]);
}

export async function salesByHour(db: Db, ctx: Ctx, r: Range) {
  const outlets = await scope(db, ctx, r.outletId);
  return db.query<{ hour: number; orders: number; covers: number; totalCents: number }>(
    `SELECT extract(hour FROM o.closed_at AT TIME ZONE ou.timezone)::int AS hour, count(*)::int AS orders, COALESCE(sum(o.covers),0)::int AS covers, COALESCE(sum(o.total_cents),0)::int AS total_cents
       FROM orders o JOIN outlets ou ON ou.id = o.outlet_id WHERE o.status = 'closed' AND o.outlet_id = ANY($1::uuid[]) AND o.business_date BETWEEN $2 AND $3 GROUP BY 1 ORDER BY 1`, [outlets, r.from, r.to]);
}

/** Item sales are gross lines (before order-level discounts); order-level discounts are reported separately in the summary. */
export async function salesByProduct(db: Db, ctx: Ctx, r: Range) {
  const outlets = await scope(db, ctx, r.outletId);
  return db.query<{ productId: string | null; name: string; category: string | null; qty: number; grossCents: number; itemDiscountCents: number }>(
    `SELECT i.product_id, i.name, c.name AS category, sum(i.qty)::int AS qty, sum(i.unit_price_cents * i.qty)::int AS gross_cents, sum(i.discount_cents)::int AS item_discount_cents
       FROM order_items i JOIN orders o ON o.id = i.order_id LEFT JOIN products p ON p.id = i.product_id LEFT JOIN categories c ON c.id = p.category_id
      WHERE o.status = 'closed' AND i.status <> 'void' AND o.outlet_id = ANY($1::uuid[]) AND o.business_date BETWEEN $2 AND $3
      GROUP BY i.product_id, i.name, c.name ORDER BY gross_cents DESC, i.name`, [outlets, r.from, r.to]);
}

export async function salesByCategory(db: Db, ctx: Ctx, r: Range) {
  const rows = await salesByProduct(db, ctx, r);
  const m = new Map<string, { category: string; qty: number; grossCents: number; itemDiscountCents: number }>();
  for (const p of rows) { const k = p.category ?? "Uncategorized"; const c = m.get(k) ?? { category: k, qty: 0, grossCents: 0, itemDiscountCents: 0 }; c.qty += p.qty; c.grossCents += p.grossCents; c.itemDiscountCents += p.itemDiscountCents; m.set(k, c); }
  return [...m.values()].sort((a, b) => b.grossCents - a.grossCents);
}

export async function salesByEmployee(db: Db, ctx: Ctx, r: Range) {
  const outlets = await scope(db, ctx, r.outletId);
  return db.query<{ employeeId: string | null; name: string | null; orders: number; covers: number; totalCents: number; tipsCents: number }>(
    `SELECT o.server_id AS employee_id, e.name, count(*)::int AS orders, COALESCE(sum(o.covers),0)::int AS covers, COALESCE(sum(o.total_cents),0)::int AS total_cents, COALESCE(sum(o.tip_cents),0)::int AS tips_cents
       FROM orders o LEFT JOIN employees e ON e.id = o.server_id WHERE o.status = 'closed' AND o.outlet_id = ANY($1::uuid[]) AND o.business_date BETWEEN $2 AND $3
      GROUP BY o.server_id, e.name ORDER BY total_cents DESC`, [outlets, r.from, r.to]);
}

export async function paymentMethods(db: Db, ctx: Ctx, r: Range) {
  const outlets = await scope(db, ctx, r.outletId);
  const pays = await db.query<{ method: string; count: number; amountCents: number; tipsCents: number }>(
    `SELECT p.method, count(*)::int AS count, sum(p.amount_cents)::int AS amount_cents, sum(p.tip_cents)::int AS tips_cents
       FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.status = 'succeeded' AND o.status = 'closed' AND o.outlet_id = ANY($1::uuid[]) AND o.business_date BETWEEN $2 AND $3 GROUP BY p.method ORDER BY p.method`, [outlets, r.from, r.to]);
  const refunds = await db.query<{ method: string; amountCents: number }>(
    `SELECT p.method, sum(rf.amount_cents)::int AS amount_cents FROM refunds rf JOIN payments p ON p.id = rf.payment_id WHERE rf.status = 'succeeded' AND rf.outlet_id = ANY($1::uuid[]) AND rf.business_date BETWEEN $2 AND $3 GROUP BY p.method`, [outlets, r.from, r.to]);
  return pays.map((p) => ({ ...p, refundedCents: refunds.find((x) => x.method === p.method)?.amountCents ?? 0 }));
}

export async function discountsAndVoids(db: Db, ctx: Ctx, r: Range) {
  const outlets = await scope(db, ctx, r.outletId);
  const discounts = await db.query<{ name: string; count: number; kind: string }>(`SELECT d.name, count(*)::int AS count, d.kind FROM order_discounts d JOIN orders o ON o.id = d.order_id WHERE o.outlet_id = ANY($1::uuid[]) AND o.business_date BETWEEN $2 AND $3 GROUP BY d.name, d.kind ORDER BY count DESC`, [outlets, r.from, r.to]);
  const voided = await db.query<{ orderNo: number; orderId: string; name: string; qty: number; amountCents: number; reason: string | null; by: string | null; approvedBy: string | null; at: Date | null }>(
    `SELECT o.order_no, o.id AS order_id, i.name, i.qty, (i.unit_price_cents * i.qty)::int AS amount_cents, i.void_reason AS reason, e.name AS by, a.name AS approved_by, i.voided_at AS at
       FROM order_items i JOIN orders o ON o.id = i.order_id LEFT JOIN employees e ON e.id = i.voided_by LEFT JOIN employees a ON a.id = i.void_approved_by
      WHERE i.status = 'void' AND i.fired_at IS NOT NULL AND o.outlet_id = ANY($1::uuid[]) AND o.business_date BETWEEN $2 AND $3 ORDER BY i.voided_at DESC LIMIT 200`, [outlets, r.from, r.to]);
  const refunds = await db.query<{ id: string; orderId: string; orderNo: number; amountCents: number; reason: string; by: string | null; approvedBy: string | null; createdAt: Date; method: string }>(
    `SELECT rf.id, rf.order_id, o.order_no, rf.amount_cents, rf.reason, e.name AS by, a.name AS approved_by, rf.created_at, p.method
       FROM refunds rf JOIN orders o ON o.id = rf.order_id JOIN payments p ON p.id = rf.payment_id LEFT JOIN employees e ON e.id = rf.created_by LEFT JOIN employees a ON a.id = rf.approved_by
      WHERE rf.status = 'succeeded' AND rf.outlet_id = ANY($1::uuid[]) AND rf.business_date BETWEEN $2 AND $3 ORDER BY rf.created_at DESC LIMIT 200`, [outlets, r.from, r.to]);
  const cancelled = await db.query<{ orderId: string; orderNo: number; reason: string | null; closedAt: Date | null }>(`SELECT id AS order_id, order_no, void_reason AS reason, closed_at FROM orders WHERE status = 'void' AND outlet_id = ANY($1::uuid[]) AND business_date BETWEEN $2 AND $3 ORDER BY closed_at DESC LIMIT 200`, [outlets, r.from, r.to]);
  return { discounts, voidedItems: voided, refunds, cancelledOrders: cancelled };
}

/** Table-service metrics. Only dine-in orders with a table and a closing time are used. */
export async function tableMetrics(db: Db, ctx: Ctx, r: Range) {
  const outlets = await scope(db, ctx, r.outletId);
  return db.query<{ tableLabel: string; turns: number; covers: number; totalCents: number; avgMinutes: number }>(
    `SELECT t.label AS table_label, count(*)::int AS turns, COALESCE(sum(o.covers),0)::int AS covers, COALESCE(sum(o.total_cents),0)::int AS total_cents,
            round(avg(extract(epoch FROM o.closed_at - o.opened_at) / 60))::int AS avg_minutes
       FROM orders o JOIN tables t ON t.id = o.table_id WHERE o.status = 'closed' AND o.type = 'dine_in' AND o.outlet_id = ANY($1::uuid[]) AND o.business_date BETWEEN $2 AND $3
      GROUP BY t.label ORDER BY total_cents DESC`, [outlets, r.from, r.to]);
}

export const drillSchema = rangeSchema.and(z.object({ employeeId: z.uuid().optional(), productId: z.uuid().optional(), method: z.enum(["cash", "card", "other"]).optional(), hour: z.coerce.number().int().min(0).max(23).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }));
/** Drill-down: the source orders behind any figure. */
export async function drillOrders(db: Db, ctx: Ctx, q: z.infer<typeof drillSchema>) {
  const outlets = await scope(db, ctx, q.outletId);
  return db.query<{ id: string; orderNo: number; businessDate: string; type: string; covers: number; totalCents: number; tipCents: number; closedAt: Date; serverName: string | null }>(
    `SELECT o.id, o.order_no, o.business_date::text, o.type, o.covers, o.total_cents, o.tip_cents, o.closed_at, e.name AS server_name
       FROM orders o JOIN outlets ou ON ou.id = o.outlet_id LEFT JOIN employees e ON e.id = o.server_id
      WHERE o.status = 'closed' AND o.outlet_id = ANY($1::uuid[]) AND o.business_date BETWEEN $2 AND $3
        AND ($4::uuid IS NULL OR o.server_id = $4)
        AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.product_id = $5 AND i.status <> 'void'))
        AND ($6::text IS NULL OR EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'succeeded' AND p.method = $6))
        AND ($7::int IS NULL OR extract(hour FROM o.closed_at AT TIME ZONE ou.timezone)::int = $7)
        AND ($8::date IS NULL OR o.business_date = $8)
      ORDER BY o.closed_at DESC LIMIT 500`, [outlets, q.from, q.to, q.employeeId ?? null, q.productId ?? null, q.method ?? null, q.hour ?? null, q.date ?? null]);
}

/**
 * Reconciliation: every closed order's billed total must equal the succeeded payments applied to it (net of nothing — refunds are
 * reported separately). Also lists exceptions: pending/declined payments, failed refunds, cash variances.
 */
export async function reconcile(db: Db, ctx: Ctx, r: Range) {
  const outlets = await scope(db, ctx, r.outletId);
  const t = await db.one<{ orders: number; billed: number; paid: number; tips: number; paidTips: number }>(
    `SELECT count(*)::int AS orders, COALESCE(sum(o.total_cents),0)::int AS billed,
            COALESCE(sum((SELECT COALESCE(sum(p.amount_cents),0) FROM payments p WHERE p.order_id = o.id AND p.status = 'succeeded')),0)::int AS paid,
            COALESCE(sum(o.tip_cents),0)::int AS tips,
            COALESCE(sum((SELECT COALESCE(sum(p.tip_cents),0) FROM payments p WHERE p.order_id = o.id AND p.status = 'succeeded')),0)::int AS paid_tips
       FROM orders o WHERE o.status = 'closed' AND o.outlet_id = ANY($1::uuid[]) AND o.business_date BETWEEN $2 AND $3`, [outlets, r.from, r.to]);
  const mismatches = await db.query<{ orderId: string; orderNo: number; billedCents: number; paidCents: number }>(
    `SELECT o.id AS order_id, o.order_no, o.total_cents AS billed_cents, COALESCE(p.s,0)::int AS paid_cents
       FROM orders o LEFT JOIN LATERAL (SELECT sum(amount_cents) AS s FROM payments WHERE order_id = o.id AND status = 'succeeded') p ON true
      WHERE o.status = 'closed' AND o.outlet_id = ANY($1::uuid[]) AND o.business_date BETWEEN $2 AND $3 AND o.total_cents <> COALESCE(p.s,0)`, [outlets, r.from, r.to]);
  const stalePending = await db.query<{ id: string; orderNo: number; amountCents: number; createdAt: Date; method: string }>(
    `SELECT p.id, o.order_no, p.amount_cents, p.created_at, p.method FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.status = 'pending' AND p.outlet_id = ANY($1::uuid[]) AND p.created_at < now() - interval '5 minutes' ORDER BY p.created_at`, [outlets]);
  const declined = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.status = 'declined' AND o.outlet_id = ANY($1::uuid[]) AND o.business_date BETWEEN $2 AND $3`, [outlets, r.from, r.to]);
  const failedRefunds = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM refunds WHERE status = 'failed' AND outlet_id = ANY($1::uuid[]) AND business_date BETWEEN $2 AND $3`, [outlets, r.from, r.to]);
  const cash = await db.query<{ id: string; drawer: string; expectedCashCents: number | null; countedCashCents: number | null; varianceCents: number | null; closedAt: Date | null }>(
    `SELECT id, drawer, expected_cash_cents, counted_cash_cents, variance_cents, closed_at FROM cash_sessions WHERE status = 'closed' AND outlet_id = ANY($1::uuid[]) AND (opened_at AT TIME ZONE 'UTC')::date BETWEEN $2::date - 1 AND $3::date + 1 AND variance_cents <> 0 ORDER BY closed_at DESC`, [outlets, r.from, r.to]);
  return {
    ok: mismatches.length === 0 && t.billed === t.paid && t.tips === t.paidTips && stalePending.length === 0,
    orders: t.orders, billedCents: t.billed, paidCents: t.paid, tipsCents: t.tips, paidTipsCents: t.paidTips,
    mismatches, pendingPayments: stalePending, declinedPayments: declined.n, failedRefunds: failedRefunds.n, cashVariances: cash,
  };
}

const csvCell = (v: unknown) => { const s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (rows: Array<Record<string, unknown>>) => {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
};

/* ───────── Day close ───────── */
export const dayCloseSchema = z.object({ outletId: z.uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

export async function endOfDayReport(db: Db, ctx: Ctx, outletId: string, date: string) {
  const r = { from: date, to: date, outletId };
  const [summary, methods, rec, dv] = await Promise.all([salesSummary(db, ctx, r), paymentMethods(db, ctx, r), reconcile(db, ctx, r), discountsAndVoids(db, ctx, r)]);
  const openOrders = await db.query<{ id: string; orderNo: number }>(`SELECT id, order_no FROM orders WHERE outlet_id = $1 AND status = 'open' AND business_date <= $2`, [outletId, date]);
  const openCash = await db.query<{ id: string; drawer: string }>(`SELECT id, drawer FROM cash_sessions WHERE outlet_id = $1 AND status = 'open'`, [outletId]);
  const closed = await db.maybe<{ closedAt: Date; summary: unknown }>(`SELECT closed_at, summary FROM day_closes WHERE outlet_id = $1 AND business_date = $2`, [outletId, date]);
  return { date, outletId, sales: summary.current, paymentMethods: methods, reconciliation: rec, voids: dv.voidedItems.length, refunds: dv.refunds, openOrders, openCashSessions: openCash, closed };
}

export async function closeDay(db: Db, ctx: Ctx, input: z.infer<typeof dayCloseSchema>) {
  assertOutletAccess(ctx, input.outletId);
  await db.exec(`SELECT 1 FROM outlets WHERE id = $1 FOR UPDATE`, [input.outletId]);
  const rep = await endOfDayReport(db, ctx, input.outletId, input.date);
  if (rep.closed) throw conflict("This business day is already closed", "DAY_ALREADY_CLOSED");
  if (rep.openOrders.length) throw conflict(`${rep.openOrders.length} order(s) are still open`, "OPEN_ORDERS", { orders: rep.openOrders });
  if (rep.openCashSessions.length) throw conflict("Close all cash sessions first", "OPEN_CASH_SESSIONS", { sessions: rep.openCashSessions });
  const summary = { sales: rep.sales, paymentMethods: rep.paymentMethods, reconciliation: { ok: rep.reconciliation.ok, orders: rep.reconciliation.orders, billedCents: rep.reconciliation.billedCents, paidCents: rep.reconciliation.paidCents } };
  await db.exec(`INSERT INTO day_closes (org_id, outlet_id, business_date, closed_by, summary) VALUES ($1,$2,$3,$4,$5)`, [ctx.orgId, input.outletId, input.date, ctx.employee.id, JSON.stringify(summary)]);
  await audit(db, ctx, "day.close", "outlet", input.outletId, { date: input.date, totalCents: rep.sales.totalCents, reconciled: rep.reconciliation.ok }, { outletId: input.outletId });
  await enqueueEvent(db, { orgId: ctx.orgId, outletId: input.outletId, key: `day.closed:${input.outletId}:${input.date}`, type: "day.closed",
    payload: { businessDate: input.date, orders: rep.sales.orders, covers: rep.sales.covers, totalCents: rep.sales.totalCents, netSalesCents: rep.sales.netSalesCents, refundsCents: rep.sales.refunds.amountCents, reconciled: rep.reconciliation.ok } });
  return { closed: true, summary };
}
