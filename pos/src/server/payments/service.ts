import { z } from "zod";
import { withOrg, notifyChange, type Db } from "@/lib/db";
import { assertOutletAccess, resolveApprover, type ApprovalInput, type Ctx } from "@/lib/auth";
import { AppError, badRequest, conflict, notFound } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { idempotent } from "@/server/idempotency";
import { enqueueEvent } from "@/server/integration/events";
import { getOrderView, lockOrder, type OrderView } from "@/server/orders/service";
import { cardProvider } from "./providers";

const IDEM = z.string().regex(/^[A-Za-z0-9_\-:.]{8,100}$/);

export const paySchema = z.object({
  method: z.enum(["cash", "card", "other"]),
  amountCents: z.number().int().min(1).max(1_000_000_000),
  tipCents: z.number().int().min(0).max(100_000_000).default(0),
  tenderedCents: z.number().int().min(0).max(1_000_000_000).optional(),
  idempotencyKey: IDEM,
  /** honoured by the TEST terminal only */
  testScenario: z.enum(["approve", "decline", "pending"]).optional(),
});

interface PaymentRow { id: string; orderId: string; outletId: string; method: string; provider: string; status: string; amountCents: number; tipCents: number; tenderedCents: number | null; changeCents: number | null; providerRef: string | null; declineReason: string | null; createdAt: Date }
const PAYMENT_COLS = `id, order_id, outlet_id, method, provider, status, amount_cents, tip_cents, tendered_cents, change_cents, provider_ref, decline_reason, created_at`;

export interface PayResult { ok: boolean; payment: PaymentRow; order: OrderView; closed: boolean }

/** Amount already committed to this order: succeeded + still-pending payments, minus succeeded refunds. */
async function committedCents(db: Db, orderId: string) {
  const r = await db.one<{ paid: number; refunded: number }>(
    `SELECT COALESCE((SELECT sum(amount_cents) FROM payments WHERE order_id = $1 AND status IN ('succeeded','pending')),0)::int AS paid,
            COALESCE((SELECT sum(amount_cents) FROM refunds WHERE order_id = $1 AND status = 'succeeded'),0)::int AS refunded`, [orderId]);
  return r.paid - r.refunded;
}

async function sessionForCash(db: Db, ctx: Ctx, outletId: string): Promise<string> {
  const rows = await db.query<{ id: string; openedBy: string }>(`SELECT id, opened_by FROM cash_sessions WHERE outlet_id = $1 AND status = 'open' ORDER BY (opened_by = $2) DESC, opened_at LIMIT 1`, [outletId, ctx.employee.id]);
  if (!rows[0]) throw conflict("Open a cash session before taking cash payments", "CASH_SESSION_REQUIRED");
  return rows[0].id;
}

/**
 * Take a payment. Three phases so a provider confirmation can never be lost:
 *  1) reserve: validate and persist a PENDING payment (committed),   2) call the provider OUTSIDE any DB transaction,
 *  3) finalize: record the provider's answer and close the order when settled.
 * Cash is confirmed by the cashier and finalized in phase 1. A crash between 1 and 3 leaves a visible pending payment
 * (listed in the reconciliation exceptions) instead of money without a record.
 */
export async function payOrder(ctx: Ctx, orderId: string, input: z.infer<typeof paySchema>): Promise<PayResult> {
  // idempotent replay?
  const existing = await withOrg(ctx.orgId, async (db) => {
    const p = await db.maybe<PaymentRow>(`SELECT ${PAYMENT_COLS} FROM payments WHERE idempotency_key = $1`, [input.idempotencyKey]);
    if (!p) return null;
    if (p.orderId !== orderId) throw conflict("This idempotency key was used for another order", "IDEMPOTENCY_MISMATCH");
    if (p.status === "pending") throw conflict("This payment is still being processed", "PAYMENT_IN_PROGRESS");
    const view = await getOrderView(db, ctx, orderId);
    return { ok: p.status === "succeeded", payment: p, order: view, closed: view.order.status === "closed" } satisfies PayResult;
  });
  if (existing) return existing;

  const provider = input.method === "card" ? cardProvider() : null;
  if (input.method === "card" && !provider) throw new AppError(422, "PROVIDER_NOT_CONFIGURED", "No card payment provider is configured. Card payments cannot be recorded without provider confirmation.");
  if (input.method === "other" && !(["owner", "manager", "supervisor"] as string[]).includes(ctx.role)) throw new AppError(403, "FORBIDDEN", "Only a supervisor can record other tenders");

  // phase 1 — reserve
  const reserved = await withOrg(ctx.orgId, async (db) => {
    const order = await lockOrder(db, ctx, orderId);
    const drafts = await db.maybe(`SELECT 1 FROM order_items WHERE order_id = $1 AND status = 'draft' LIMIT 1`, [orderId]);
    if (drafts) throw conflict("Send the new items to the kitchen before taking payment", "DRAFT_ITEMS");
    const view = await getOrderView(db, ctx, orderId);
    if (view.totals.totalCents <= 0) throw conflict("This order has nothing to pay", "NOTHING_TO_PAY");
    const committed = await committedCents(db, orderId);
    const due = view.totals.totalCents - committed;
    if (input.amountCents > due) throw conflict(`The amount exceeds what is due (${due})`, "OVERPAYMENT", { dueCents: due });
    let tendered: number | null = null; let change: number | null = null; let sessionId: string | null = null;
    if (input.method === "cash") {
      sessionId = await sessionForCash(db, ctx, order.outletId);
      tendered = input.tenderedCents ?? input.amountCents + input.tipCents;
      if (tendered < input.amountCents + input.tipCents) throw badRequest("The cash tendered does not cover the amount", "TENDERED_TOO_LOW");
      change = tendered - input.amountCents - input.tipCents;
    }
    const status = input.method === "card" ? "pending" : "succeeded";
    const p = await db.one<PaymentRow>(
      `INSERT INTO payments (org_id, outlet_id, order_id, method, provider, status, amount_cents, tip_cents, tendered_cents, change_cents, idempotency_key, cash_session_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${PAYMENT_COLS}`,
      [ctx.orgId, order.outletId, orderId, input.method, input.method === "card" ? provider!.id : input.method, status, input.amountCents, input.tipCents, tendered, change, input.idempotencyKey, sessionId, ctx.employee.id]);
    await audit(db, ctx, "payment.reserved", "payment", p.id, { method: input.method, amountCents: input.amountCents, tipCents: input.tipCents }, { orderId, outletId: order.outletId });
    if (input.method === "card") return { p, closed: false as const, currency: ctx.org.currency };
    const closed = await finalizeAndClose(db, ctx, orderId, p);
    return { p, closed, currency: ctx.org.currency };
  });

  if (input.method !== "card") {
    return withOrg(ctx.orgId, async (db) => ({ ok: true, payment: await loadPayment(db, reserved.p.id), order: await getOrderView(db, ctx, orderId), closed: reserved.closed }));
  }

  // phase 2 — provider call, outside any transaction
  let result;
  try {
    result = await provider!.charge({ amountCents: input.amountCents, tipCents: input.tipCents, currency: reserved.currency, reference: reserved.p.id, idempotencyKey: reserved.p.id, scenario: input.testScenario });
  } catch (e) {
    // unknown outcome: leave the payment PENDING for reconciliation rather than guessing
    await withOrg(ctx.orgId, (db) => audit(db, ctx, "payment.provider_error", "payment", reserved.p.id, { error: String((e as Error).message).slice(0, 200) }, { orderId }));
    throw new AppError(502, "PROVIDER_ERROR", "The payment provider did not answer. The payment is pending — check the terminal before retrying.", { paymentId: reserved.p.id });
  }

  // phase 3 — finalize
  return withOrg(ctx.orgId, async (db) => {
    const order = await lockOrder(db, ctx, orderId, { allow: ["open"] });
    if (result.status === "pending") {
      await db.exec(`UPDATE payments SET provider_ref = $2 WHERE id = $1`, [reserved.p.id, result.providerRef ?? null]);
      return { ok: false, payment: await loadPayment(db, reserved.p.id), order: await getOrderView(db, ctx, orderId), closed: false };
    }
    if (result.status === "declined") {
      await db.exec(`UPDATE payments SET status = 'declined', decline_reason = $2, provider_ref = $3 WHERE id = $1`, [reserved.p.id, result.declineReason ?? "Declined", result.providerRef ?? null]);
      await audit(db, ctx, "payment.declined", "payment", reserved.p.id, { reason: result.declineReason ?? null }, { orderId, outletId: order.outletId });
      return { ok: false, payment: await loadPayment(db, reserved.p.id), order: await getOrderView(db, ctx, orderId), closed: false };
    }
    await db.exec(`UPDATE payments SET status = 'succeeded', provider_ref = $2 WHERE id = $1`, [reserved.p.id, result.providerRef ?? null]);
    const p = await loadPayment(db, reserved.p.id);
    const closed = await finalizeAndClose(db, ctx, orderId, p);
    return { ok: true, payment: p, order: await getOrderView(db, ctx, orderId), closed };
  });
}

async function loadPayment(db: Db, id: string) { return db.one<PaymentRow>(`SELECT ${PAYMENT_COLS} FROM payments WHERE id = $1`, [id]); }

/** After a succeeded payment: publish the payment event and close the order when it is fully settled. */
async function finalizeAndClose(db: Db, ctx: Ctx, orderId: string, p: PaymentRow): Promise<boolean> {
  const order = await db.one<{ outletId: string; orderNo: number; businessDate: string; version: number; type: string; covers: number; openedAt: Date; serverId: string | null }>(
    `SELECT outlet_id, order_no, business_date::text, version, type, covers, opened_at, server_id FROM orders WHERE id = $1`, [orderId]);
  await audit(db, ctx, "payment.succeeded", "payment", p.id, { method: p.method, amountCents: p.amountCents, tipCents: p.tipCents, provider: p.provider }, { orderId, outletId: order.outletId });
  await enqueueEvent(db, { orgId: ctx.orgId, outletId: order.outletId, key: `payment.recorded:${p.id}`, type: "payment.recorded",
    payload: { paymentId: p.id, orderId, orderNo: order.orderNo, businessDate: order.businessDate, method: p.method, provider: p.provider, amountCents: p.amountCents, tipCents: p.tipCents, currency: ctx.org.currency } });
  const view = await getOrderView(db, ctx, orderId);
  const pending = await db.maybe(`SELECT 1 FROM payments WHERE order_id = $1 AND status = 'pending'`, [orderId]);
  const paid = view.paidCents;
  if (pending || paid < view.totals.totalCents) { await notifyChange(db, ctx.orgId, order.outletId, "order"); return false; }
  const held = await db.maybe(`SELECT 1 FROM order_items WHERE order_id = $1 AND status = 'held' LIMIT 1`, [orderId]);
  if (held) { await notifyChange(db, ctx.orgId, order.outletId, "order"); return false; } // fully paid but held courses remain: staff must fire or remove them
  const t = view.totals;
  const tips = await db.one<{ s: number }>(`SELECT COALESCE(sum(tip_cents),0)::int AS s FROM payments WHERE order_id = $1 AND status = 'succeeded'`, [orderId]);
  await db.exec(
    `UPDATE orders SET status = 'closed', closed_at = now(), closed_by = $2, gross_cents = $3, item_discount_cents = $4, order_discount_cents = $5, service_charge_cents = $6,
       tax_cents = $7, total_cents = $8, net_sales_cents = $9, tip_cents = $10, totals_snapshot = $11, bill_requested_at = NULL WHERE id = $1`,
    [orderId, ctx.employee.id, t.grossCents, t.itemDiscountCents, t.orderDiscountCents, t.serviceChargeCents, t.taxCents, t.totalCents, t.netSalesCents, tips.s, JSON.stringify(t)]);
  await audit(db, ctx, "order.close", "order", orderId, { totalCents: t.totalCents, tipCents: tips.s }, { orderId, outletId: order.outletId });
  const items = view.items.filter((i) => i.status !== "void");
  await enqueueEvent(db, { orgId: ctx.orgId, outletId: order.outletId, key: `order.closed:${orderId}:v${order.version}`, type: "order.closed",
    payload: {
      orderId, orderNo: order.orderNo, businessDate: order.businessDate, type: order.type, covers: order.covers, openedAt: order.openedAt, closedAt: new Date().toISOString(), currency: ctx.org.currency,
      totals: { grossCents: t.grossCents, discountCents: t.itemDiscountCents + t.orderDiscountCents, serviceChargeCents: t.serviceChargeCents, taxCents: t.taxCents, netSalesCents: t.netSalesCents, totalCents: t.totalCents, tipCents: tips.s },
      payments: view.payments.filter((x) => x.status === "succeeded").map((x) => ({ id: x.id, method: x.method, amountCents: x.amountCents, tipCents: x.tipCents })),
      items: items.map((i) => ({ productId: i.productId, name: i.name, qty: i.qty, unitPriceCents: i.unitPriceCents, discountCents: i.discountCents })),
    } });
  await notifyChange(db, ctx.orgId, order.outletId, "order");
  return true;
}

/** Close an order whose total is zero (e.g. fully comped) without any payment. */
export async function closeZeroOrder(ctx: Ctx, orderId: string): Promise<OrderView> {
  return withOrg(ctx.orgId, async (db) => {
    const order = await lockOrder(db, ctx, orderId);
    const drafts = await db.maybe(`SELECT 1 FROM order_items WHERE order_id = $1 AND status IN ('draft','held') LIMIT 1`, [orderId]);
    if (drafts) throw conflict("Send or remove unsent items first", "DRAFT_ITEMS");
    const view = await getOrderView(db, ctx, orderId);
    if (view.totals.totalCents !== 0) throw conflict("This order has an amount due", "AMOUNT_DUE");
    if (!view.items.some((i) => i.status !== "void") ) throw conflict("The order is empty; void it instead", "ORDER_EMPTY");
    const t = view.totals;
    await db.exec(`UPDATE orders SET status = 'closed', closed_at = now(), closed_by = $2, gross_cents = $3, item_discount_cents = $4, order_discount_cents = $5, service_charge_cents = $6, tax_cents = $7, total_cents = 0, net_sales_cents = $8, tip_cents = 0, totals_snapshot = $9 WHERE id = $1`,
      [orderId, ctx.employee.id, t.grossCents, t.itemDiscountCents, t.orderDiscountCents, t.serviceChargeCents, t.taxCents, t.netSalesCents, JSON.stringify(t)]);
    await audit(db, ctx, "order.close_zero", "order", orderId, {}, { orderId, outletId: order.outletId });
    await enqueueEvent(db, { orgId: ctx.orgId, outletId: order.outletId, key: `order.closed:${orderId}:v${order.version}`, type: "order.closed",
      payload: { orderId, orderNo: order.orderNo, businessDate: order.businessDate, type: order.type, covers: order.covers, currency: ctx.org.currency, totals: { grossCents: t.grossCents, discountCents: t.itemDiscountCents + t.orderDiscountCents, serviceChargeCents: 0, taxCents: t.taxCents, netSalesCents: t.netSalesCents, totalCents: 0, tipCents: 0 }, payments: [], items: [] } });
    await notifyChange(db, ctx.orgId, order.outletId, "order");
    return getOrderView(db, ctx, orderId);
  });
}

/* ───────────────────────── Refunds ───────────────────────── */
export const refundSchema = z.object({
  amountCents: z.number().int().min(1).max(1_000_000_000),
  reason: z.string().trim().min(3, "A reason is required").max(200),
  approval: z.object({ employeeId: z.uuid(), pin: z.string().min(4).max(8) }).optional(),
  idempotencyKey: IDEM,
});

export async function refundPayment(ctx: Ctx, paymentId: string, input: z.infer<typeof refundSchema>) {
  const replay = await withOrg(ctx.orgId, async (db) => {
    const r = await db.maybe<{ id: string; paymentId: string; status: string }>(`SELECT id, payment_id, status FROM refunds WHERE idempotency_key = $1`, [input.idempotencyKey]);
    if (!r) return null;
    if (r.paymentId !== paymentId) throw conflict("This idempotency key was used for another refund", "IDEMPOTENCY_MISMATCH");
    if (r.status === "pending") throw conflict("This refund is still being processed", "REFUND_IN_PROGRESS");
    return r;
  });
  if (replay) return { refundId: replay.id, status: replay.status };

  const prep = await withOrg(ctx.orgId, async (db) => {
    const p = await db.maybe<{ id: string; orderId: string; outletId: string; method: string; provider: string; status: string; amountCents: number; providerRef: string | null }>(
      `SELECT id, order_id, outlet_id, method, provider, status, amount_cents, provider_ref FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
    if (!p) throw notFound("Payment");
    assertOutletAccess(ctx, p.outletId);
    if (p.status !== "succeeded") throw conflict("Only succeeded payments can be refunded", "PAYMENT_NOT_REFUNDABLE");
    const approver = await resolveApprover(db, ctx, "refunds.approve", input.approval as ApprovalInput | undefined);
    const done = await db.one<{ s: number }>(`SELECT COALESCE(sum(amount_cents),0)::int AS s FROM refunds WHERE payment_id = $1 AND status IN ('succeeded','pending')`, [paymentId]);
    const left = p.amountCents - done.s;
    if (input.amountCents > left) throw conflict(`Only ${left} can still be refunded on this payment`, "REFUND_EXCEEDS_PAYMENT", { refundableCents: left });
    let sessionId: string | null = null;
    if (p.method === "cash") {
      sessionId = await sessionForCash(db, ctx, p.outletId);
    }
    const bd = await db.one<{ d: string }>(`SELECT ((now() AT TIME ZONE o.timezone) - make_interval(hours => o.business_day_start_hour))::date::text AS d FROM outlets o WHERE o.id = $1`, [p.outletId]);
    const r = await db.one<{ id: string }>(
      `INSERT INTO refunds (org_id, outlet_id, order_id, payment_id, amount_cents, reason, status, provider, cash_session_id, business_date, created_by, approved_by, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [ctx.orgId, p.outletId, p.orderId, paymentId, input.amountCents, input.reason, p.method === "card" ? "pending" : "succeeded", p.provider, sessionId, bd.d, ctx.employee.id, approver, input.idempotencyKey]);
    await audit(db, ctx, "refund.reserved", "refund", r.id, { paymentId, amountCents: input.amountCents, reason: input.reason, method: p.method }, { orderId: p.orderId, outletId: p.outletId, approverId: approver });
    if (p.method !== "card") await publishRefund(db, ctx, r.id, bd.d, p, input.amountCents, input.reason);
    return { id: r.id, p, bd: bd.d };
  });
  if (prep.p.method !== "card") return { refundId: prep.id, status: "succeeded" as const };

  const provider = cardProvider();
  if (!provider) throw new AppError(422, "PROVIDER_NOT_CONFIGURED", "No card payment provider is configured");
  let res;
  try { res = await provider.refund({ amountCents: input.amountCents, currency: ctx.org.currency, paymentProviderRef: prep.p.providerRef, idempotencyKey: prep.id }); }
  catch { throw new AppError(502, "PROVIDER_ERROR", "The payment provider did not answer. The refund is pending — verify before retrying.", { refundId: prep.id }); }
  return withOrg(ctx.orgId, async (db) => {
    if (res.status === "succeeded") {
      await db.exec(`UPDATE refunds SET status = 'succeeded', provider_ref = $2 WHERE id = $1`, [prep.id, res.providerRef ?? null]);
      await publishRefund(db, ctx, prep.id, prep.bd, prep.p, input.amountCents, input.reason);
    } else if (res.status === "failed") {
      await db.exec(`UPDATE refunds SET status = 'failed' WHERE id = $1`, [prep.id]);
      await audit(db, ctx, "refund.failed", "refund", prep.id, { error: res.error ?? null }, { orderId: prep.p.orderId, outletId: prep.p.outletId });
    }
    return { refundId: prep.id, status: res.status };
  });
}

async function publishRefund(db: Db, ctx: Ctx, refundId: string, businessDate: string, p: { orderId: string; outletId: string; method: string }, amountCents: number, reason: string) {
  await audit(db, ctx, "refund.succeeded", "refund", refundId, { amountCents, reason }, { orderId: p.orderId, outletId: p.outletId });
  await enqueueEvent(db, { orgId: ctx.orgId, outletId: p.outletId, key: `refund.recorded:${refundId}`, type: "refund.recorded",
    payload: { refundId, orderId: p.orderId, businessDate, method: p.method, amountCents, reason, currency: ctx.org.currency } });
  await notifyChange(db, ctx.orgId, p.outletId, "order");
}

/* ───────────────────────── Receipt ───────────────────────── */
export async function receiptFor(db: Db, ctx: Ctx, orderId: string) {
  const view = await getOrderView(db, ctx, orderId);
  const outlet = await db.one<{ name: string; address: string | null; phone: string | null; taxIdentifier: string | null; receiptHeader: string | null; receiptFooter: string | null }>(
    `SELECT name, address, phone, tax_identifier, receipt_header, receipt_footer FROM outlets WHERE id = $1`, [view.order.outletId]);
  return {
    outlet, order: { id: view.order.id, orderNo: view.order.orderNo, businessDate: view.order.businessDate, type: view.order.type, tableLabel: view.order.tableLabel, covers: view.order.covers, serverName: view.order.serverName, openedAt: view.order.openedAt, closedAt: view.order.closedAt, status: view.order.status },
    items: view.items.filter((i) => i.status !== "void").map((i) => ({ name: i.name, qty: i.qty, unitPriceCents: i.unitPriceCents, discountCents: i.discountCents, modifiers: i.modifiers.map((m) => m.name), taxRateBps: i.taxRateBps })),
    discounts: view.discounts, totals: view.totals, tipCents: view.payments.filter((p) => p.status === "succeeded").reduce((a, p) => a + p.tipCents, 0),
    payments: view.payments.filter((p) => p.status === "succeeded"), refundedCents: view.refundedCents, currency: ctx.org.currency, pricesIncludeTax: view.outlet.pricesIncludeTax,
    fiscalNotice: "This receipt has NOT been validated against Moroccan fiscal requirements. Have it reviewed by a qualified accountant before commercial use.",
  };
}
