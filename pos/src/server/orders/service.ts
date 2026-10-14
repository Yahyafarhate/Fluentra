import { z } from "zod";
import { notifyChange, type Db } from "@/lib/db";
import { assertOutletAccess, resolveApprover, type ApprovalInput, type Ctx } from "@/lib/auth";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { bps } from "@/lib/money";
import { computeTotals, type Totals } from "./totals";
import { loadOutlet, type OutletRow } from "@/server/outlets/service";
import { enqueueEvent } from "@/server/integration/events";

export interface OrderRow {
  id: string; outletId: string; orderNo: number; businessDate: string; type: string; status: string; tableId: string | null; covers: number;
  serverId: string | null; openedBy: string | null; roomRef: string | null; note: string | null; openedAt: Date; closedAt: Date | null;
  billRequestedAt: Date | null; version: number; tipCents: number;
}
export interface ItemView {
  id: string; productId: string | null; name: string; unitPriceCents: number; qty: number; taxRateBps: number; stationKind: string; seat: number | null;
  course: number; hold: boolean; status: string; note: string | null; allergyNote: string | null; voidReason: string | null; discountCents: number;
  createdAt: Date; firedAt: Date | null; modifiers: Array<{ id: string; name: string; priceDeltaCents: number }>;
}
export interface OrderView {
  order: OrderRow & { tableLabel: string | null; serverName: string | null; tables: Array<{ id: string; label: string }> };
  items: ItemView[];
  discounts: Array<{ id: string; name: string; kind: string; value: number; reason: string }>;
  totals: Totals;
  payments: Array<{ id: string; method: string; provider: string; status: string; amountCents: number; tipCents: number; createdAt: Date }>;
  refundedCents: number;
  paidCents: number;
  dueCents: number;
  outlet: { id: string; name: string; currency: string; pricesIncludeTax: boolean };
}

export const businessDateSql = `((now() AT TIME ZONE o.timezone) - make_interval(hours => o.business_day_start_hour))::date`;

/** Locks the order row for the rest of the transaction (serializes concurrent edits from several terminals). */
export async function lockOrder(db: Db, ctx: Ctx, orderId: string, opts: { allow?: Array<"open" | "closed"> } = {}): Promise<OrderRow> {
  const o = await db.maybe<OrderRow>(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
  if (!o) throw notFound("Order");
  assertOutletAccess(ctx, o.outletId);
  const allowed = opts.allow ?? ["open"];
  if (!(allowed as string[]).includes(o.status)) throw conflict(`This order is ${o.status}`, o.status === "closed" ? "ORDER_CLOSED" : "ORDER_NOT_OPEN");
  return o;
}

export async function getOrderView(db: Db, ctx: Ctx, orderId: string): Promise<OrderView> {
  const o = await db.maybe<OrderRow & { tableLabel: string | null; serverName: string | null }>(
    `SELECT o.*, t.label AS table_label, e.name AS server_name FROM orders o LEFT JOIN tables t ON t.id = o.table_id LEFT JOIN employees e ON e.id = o.server_id WHERE o.id = $1`, [orderId]);
  if (!o) throw notFound("Order");
  assertOutletAccess(ctx, o.outletId);
  const outlet = await loadOutlet(db, ctx, o.outletId);
  const [items, mods, discounts, payments, refunds, tables] = await Promise.all([
    db.query<Omit<ItemView, "modifiers">>(`SELECT id, product_id, name, unit_price_cents, qty, tax_rate_bps, station_kind, seat, course, hold, status, note, allergy_note, void_reason, discount_cents, created_at, fired_at FROM order_items WHERE order_id = $1 ORDER BY created_at, id`, [orderId]),
    db.query<{ orderItemId: string; id: string; name: string; priceDeltaCents: number }>(`SELECT m.order_item_id, m.id, m.name, m.price_delta_cents FROM order_item_modifiers m JOIN order_items i ON i.id = m.order_item_id WHERE i.order_id = $1`, [orderId]),
    db.query<{ id: string; name: string; kind: string; value: number; reason: string }>(`SELECT id, name, kind, value, reason FROM order_discounts WHERE order_id = $1 ORDER BY created_at`, [orderId]),
    db.query<OrderView["payments"][number]>(`SELECT id, method, provider, status, amount_cents, tip_cents, created_at FROM payments WHERE order_id = $1 ORDER BY created_at`, [orderId]),
    db.one<{ s: number }>(`SELECT COALESCE(sum(amount_cents),0)::int AS s FROM refunds WHERE order_id = $1 AND status = 'succeeded'`, [orderId]),
    db.query<{ id: string; label: string }>(`SELECT t.id, t.label FROM order_tables ot JOIN tables t ON t.id = ot.table_id WHERE ot.order_id = $1 ORDER BY t.label`, [orderId]),
  ]);
  const itemViews: ItemView[] = items.map((i) => ({ ...i, modifiers: mods.filter((m) => m.orderItemId === i.id).map((m) => ({ id: m.id, name: m.name, priceDeltaCents: m.priceDeltaCents })) }));
  const live = itemViews.filter((i) => i.status !== "void");
  const computed = computeTotals(
    live.map((i) => ({ id: i.id, unitPriceCents: i.unitPriceCents, qty: i.qty, taxRateBps: i.taxRateBps, discountCents: i.discountCents })),
    discounts.map((d) => ({ kind: d.kind as "percent" | "amount", value: d.value })),
    outlet,
  );
  // closed orders report their immutable snapshot, never a recomputation with today's settings
  const snapshot = (o as unknown as { status: string; totalsSnapshot: Totals | null });
  const totals = snapshot.status === "closed" && snapshot.totalsSnapshot ? snapshot.totalsSnapshot : computed;
  const paid = payments.filter((p) => p.status === "succeeded").reduce((a, p) => a + p.amountCents, 0);
  const refunded = refunds.s;
  return {
    order: { ...o, tables }, items: itemViews, discounts, totals, payments, refundedCents: refunded, paidCents: paid - refunded,
    dueCents: Math.max(0, totals.totalCents - (paid - refunded)),
    outlet: { id: outlet.id, name: outlet.name, currency: ctx.org.currency, pricesIncludeTax: outlet.pricesIncludeTax },
  };
}

const changed = (db: Db, ctx: Ctx, outletId: string, kind: string) => notifyChange(db, ctx.orgId, outletId, kind);

/* ───────────────────────── Open ───────────────────────── */
export const openOrderSchema = z.object({
  outletId: z.uuid(),
  type: z.enum(["dine_in", "takeaway", "room_service", "delivery"]).default("dine_in"),
  tableId: z.uuid().nullable().optional(),
  covers: z.number().int().min(0).max(200).optional(),
  roomRef: z.string().trim().max(60).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});

async function assertTableFree(db: Db, tableId: string, outletId: string) {
  const t = await db.maybe<{ active: boolean; outletId: string }>(`SELECT active, outlet_id FROM tables WHERE id = $1`, [tableId]);
  if (!t || t.outletId !== outletId) throw notFound("Table");
  if (!t.active) throw conflict("This table is disabled", "TABLE_DISABLED");
  const busy = await db.maybe(`SELECT 1 FROM orders WHERE table_id = $1 AND status = 'open' UNION ALL SELECT 1 FROM order_tables ot JOIN orders o ON o.id = ot.order_id WHERE ot.table_id = $1 AND o.status = 'open' LIMIT 1`, [tableId]);
  if (busy) throw conflict("This table already has an open order", "TABLE_OCCUPIED");
}

export async function openOrder(db: Db, ctx: Ctx, input: z.infer<typeof openOrderSchema>) {
  const outlet = await loadOutlet(db, ctx, input.outletId);
  if (!outlet.active) throw conflict("This outlet is closed", "OUTLET_INACTIVE");
  const covers = input.covers ?? (input.type === "dine_in" ? 0 : 1);
  if (input.type === "dine_in") {
    if (!input.tableId) throw badRequest("A table is required for dine-in orders", "TABLE_REQUIRED");
    if (covers < 1) throw badRequest("Enter the number of covers", "COVERS_REQUIRED");
  }
  if (input.tableId) await assertTableFree(db, input.tableId, input.outletId);
  const bd = await db.one<{ d: string }>(`SELECT ((now() AT TIME ZONE $1) - make_interval(hours => $2))::date::text AS d`, [outlet.timezone, outlet.businessDayStartHour]);
  const no = await db.one<{ n: number }>(
    `INSERT INTO order_counters (org_id, outlet_id, business_date, last_no) VALUES ($1,$2,$3,1)
     ON CONFLICT (outlet_id, business_date) DO UPDATE SET last_no = order_counters.last_no + 1 RETURNING last_no AS n`, [ctx.orgId, input.outletId, bd.d]);
  let row: { id: string };
  try {
    row = await db.one<{ id: string }>(
      `INSERT INTO orders (org_id, outlet_id, order_no, business_date, type, table_id, covers, server_id, opened_by, room_ref, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10) RETURNING id`,
      [ctx.orgId, input.outletId, no.n, bd.d, input.type, input.tableId ?? null, covers, ctx.employee.id, input.roomRef ?? null, input.note ?? null]);
  } catch (e) {
    if ((e as { code?: string }).code === "23505" && (e as { constraint?: string }).constraint === "orders_one_open_per_table") throw conflict("This table already has an open order", "TABLE_OCCUPIED");
    throw e;
  }
  await audit(db, ctx, "order.open", "order", row.id, { type: input.type, tableId: input.tableId ?? null, covers }, { orderId: row.id, outletId: input.outletId });
  await changed(db, ctx, input.outletId, "order");
  return getOrderView(db, ctx, row.id);
}

/* ───────────────────────── Items ───────────────────────── */
export const addItemsSchema = z.object({
  items: z.array(z.object({
    productId: z.uuid(), qty: z.number().int().min(1).max(99).default(1),
    modifierIds: z.array(z.uuid()).max(30).default([]),
    note: z.string().trim().max(200).nullable().optional(), allergyNote: z.string().trim().max(200).nullable().optional(),
    seat: z.number().int().min(1).max(60).nullable().optional(), course: z.number().int().min(1).max(6).optional(), hold: z.boolean().optional(),
  })).min(1).max(40),
});

export async function addItems(db: Db, ctx: Ctx, orderId: string, input: z.infer<typeof addItemsSchema>) {
  const order = await lockOrder(db, ctx, orderId);
  const covers = order.covers;
  for (const it of input.items) {
    if (it.seat && order.type === "dine_in" && covers > 0 && it.seat > Math.max(covers, 1) + 20) throw badRequest("Invalid seat", "INVALID_SEAT");
    const p = await db.maybe<{ id: string; name: string; priceCents: number; taxRateBps: number; stationKind: string; defaultCourse: number; available: boolean }>(
      `SELECT p.id, p.name, COALESCE(po.price_cents, p.price_cents) AS price_cents, t.rate_bps AS tax_rate_bps, p.station_kind, p.default_course,
              (p.available AND COALESCE(po.available, true)) AS available
         FROM products p JOIN tax_rates t ON t.id = p.tax_rate_id LEFT JOIN product_outlets po ON po.product_id = p.id AND po.outlet_id = $2
        WHERE p.id = $1 AND p.active AND NOT COALESCE(po.hidden, false)`, [it.productId, order.outletId]);
    if (!p) throw notFound("Product");
    if (!p.available) throw conflict(`"${p.name}" is out of stock`, "OUT_OF_STOCK", { productId: p.id });
    // modifiers must belong to this product's groups, and group min/max must hold
    const groups = await db.query<{ id: string; name: string; minSelect: number; maxSelect: number }>(
      `SELECT g.id, g.name, g.min_select, g.max_select FROM product_modifier_groups pg JOIN modifier_groups g ON g.id = pg.group_id WHERE pg.product_id = $1`, [p.id]);
    const mods = it.modifierIds.length
      ? await db.query<{ id: string; groupId: string; name: string; priceDeltaCents: number }>(`SELECT m.id, m.group_id, m.name, m.price_delta_cents FROM modifiers m WHERE m.id = ANY($1::uuid[]) AND m.active`, [it.modifierIds])
      : [];
    if (new Set(it.modifierIds).size !== it.modifierIds.length || mods.length !== it.modifierIds.length) throw badRequest("Unknown or duplicate modifier", "INVALID_MODIFIER");
    for (const m of mods) if (!groups.some((g) => g.id === m.groupId)) throw badRequest(`Modifier "${m.name}" does not belong to ${p.name}`, "INVALID_MODIFIER");
    for (const g of groups) {
      const n = mods.filter((m) => m.groupId === g.id).length;
      if (n < g.minSelect) throw badRequest(`Choose at least ${g.minSelect} for "${g.name}"`, "MODIFIER_REQUIRED", { groupId: g.id });
      if (n > g.maxSelect) throw badRequest(`Choose at most ${g.maxSelect} for "${g.name}"`, "MODIFIER_LIMIT", { groupId: g.id });
    }
    const unit = p.priceCents + mods.reduce((a, m) => a + m.priceDeltaCents, 0);
    if (unit < 0) throw badRequest("Item price cannot be negative", "INVALID_PRICE");
    const item = await db.one<{ id: string }>(
      `INSERT INTO order_items (org_id, order_id, product_id, name, unit_price_cents, qty, tax_rate_bps, station_kind, seat, course, hold, note, allergy_note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [ctx.orgId, orderId, p.id, p.name, unit, it.qty, p.taxRateBps, p.stationKind, it.seat ?? null, it.course ?? p.defaultCourse, it.hold ?? false, it.note ?? null, it.allergyNote ?? null, ctx.employee.id]);
    for (const m of mods) await db.exec(`INSERT INTO order_item_modifiers (org_id, order_item_id, modifier_id, name, price_delta_cents) VALUES ($1,$2,$3,$4,$5)`, [ctx.orgId, item.id, m.id, m.name, m.priceDeltaCents]);
  }
  await db.exec(`UPDATE orders SET bill_requested_at = NULL WHERE id = $1`, [orderId]); // new items cancel a pending bill request
  await audit(db, ctx, "order.add_items", "order", orderId, { count: input.items.length }, { orderId, outletId: order.outletId });
  await changed(db, ctx, order.outletId, "order");
  return getOrderView(db, ctx, orderId);
}

export const updateItemSchema = z.object({
  qty: z.number().int().min(1).max(99).optional(), note: z.string().trim().max(200).nullable().optional(), allergyNote: z.string().trim().max(200).nullable().optional(),
  seat: z.number().int().min(1).max(60).nullable().optional(), course: z.number().int().min(1).max(6).optional(), hold: z.boolean().optional(),
});

async function lockItem(db: Db, orderId: string, itemId: string) {
  const it = await db.maybe<{ id: string; status: string; unitPriceCents: number; qty: number; name: string }>(`SELECT id, status, unit_price_cents, qty, name FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE`, [itemId, orderId]);
  if (!it) throw notFound("Item");
  return it;
}

export async function updateItem(db: Db, ctx: Ctx, orderId: string, itemId: string, input: z.infer<typeof updateItemSchema>) {
  const order = await lockOrder(db, ctx, orderId);
  const it = await lockItem(db, orderId, itemId);
  if (!["draft", "held"].includes(it.status)) throw conflict("This item was already sent to the kitchen. Void it and add it again.", "ITEM_ALREADY_SENT");
  await db.exec(
    `UPDATE order_items SET qty = COALESCE($2,qty), note = CASE WHEN $3::boolean THEN $4 ELSE note END, allergy_note = CASE WHEN $5::boolean THEN $6 ELSE allergy_note END,
       seat = CASE WHEN $7::boolean THEN $8::smallint ELSE seat END, course = COALESCE($9,course), hold = COALESCE($10,hold) WHERE id = $1`,
    [itemId, input.qty ?? null, input.note !== undefined, input.note ?? null, input.allergyNote !== undefined, input.allergyNote ?? null, input.seat !== undefined, input.seat ?? null, input.course ?? null, input.hold ?? null]);
  await audit(db, ctx, "order.update_item", "order_item", itemId, input, { orderId, outletId: order.outletId });
  await changed(db, ctx, order.outletId, "order");
  return getOrderView(db, ctx, orderId);
}

export const voidItemSchema = z.object({
  reason: z.string().trim().min(3, "A reason is required").max(200),
  approval: z.object({ employeeId: z.uuid(), pin: z.string().min(4).max(8) }).optional(),
});

/** Draft items are simply removed; items already sent require a reason AND `items.void_sent` authority (own or a supervisor's PIN). */
export async function voidItem(db: Db, ctx: Ctx, orderId: string, itemId: string, input: z.infer<typeof voidItemSchema>) {
  const order = await lockOrder(db, ctx, orderId);
  const it = await lockItem(db, orderId, itemId);
  if (it.status === "void") throw conflict("Already voided", "ALREADY_VOID");
  if (["draft", "held"].includes(it.status)) {
    await db.exec(`DELETE FROM order_items WHERE id = $1`, [itemId]);
    await audit(db, ctx, "order.remove_unsent_item", "order_item", itemId, { name: it.name, reason: input.reason }, { orderId, outletId: order.outletId });
  } else {
    const approver = await resolveApprover(db, ctx, "items.void_sent", input.approval as ApprovalInput | undefined);
    await db.exec(`UPDATE order_items SET status = 'void', void_reason = $2, voided_by = $3, voided_at = now(), void_approved_by = $4 WHERE id = $1`, [itemId, input.reason, ctx.employee.id, approver]);
    await audit(db, ctx, "order.void_item", "order_item", itemId, { name: it.name, qty: it.qty, amountCents: it.unitPriceCents * it.qty, reason: input.reason, statusWas: it.status }, { orderId, outletId: order.outletId, approverId: approver });
    await enqueueEvent(db, { orgId: ctx.orgId, outletId: order.outletId, key: `item.voided:${itemId}`, type: "item.voided",
      payload: { orderId, itemId, name: it.name, qty: it.qty, amountCents: it.unitPriceCents * it.qty, reason: input.reason, businessDate: order.businessDate } });
  }
  await changed(db, ctx, order.outletId, "order");
  return getOrderView(db, ctx, orderId);
}

/* ───────────────────────── Send / fire / serve ───────────────────────── */
export async function sendOrder(db: Db, ctx: Ctx, orderId: string) {
  const order = await lockOrder(db, ctx, orderId);
  const drafts = await db.query<{ id: string; course: number; hold: boolean; stationKind: string }>(`SELECT id, course, hold, station_kind FROM order_items WHERE order_id = $1 AND status = 'draft'`, [orderId]);
  if (!drafts.length) throw conflict("Nothing new to send", "NOTHING_TO_SEND");
  let fired = 0, held = 0;
  for (const d of drafts) {
    if (d.stationKind === "none") { await db.exec(`UPDATE order_items SET status = 'served', fired_at = now(), served_at = now() WHERE id = $1`, [d.id]); continue; }
    if (d.hold || d.course > 1) { await db.exec(`UPDATE order_items SET status = 'held' WHERE id = $1`, [d.id]); held++; }
    else { await db.exec(`UPDATE order_items SET status = 'fired', fired_at = now() WHERE id = $1`, [d.id]); fired++; }
  }
  await audit(db, ctx, "order.send", "order", orderId, { fired, held }, { orderId, outletId: order.outletId });
  await changed(db, ctx, order.outletId, "kitchen");
  return getOrderView(db, ctx, orderId);
}

export async function fireCourse(db: Db, ctx: Ctx, orderId: string, course: number) {
  const order = await lockOrder(db, ctx, orderId);
  const n = await db.exec(`UPDATE order_items SET status = 'fired', fired_at = now() WHERE order_id = $1 AND status = 'held' AND course = $2`, [orderId, course]);
  if (!n) throw conflict(`No held items in course ${course}`, "NOTHING_TO_FIRE");
  await audit(db, ctx, "order.fire_course", "order", orderId, { course, items: n }, { orderId, outletId: order.outletId });
  await changed(db, ctx, order.outletId, "kitchen");
  return getOrderView(db, ctx, orderId);
}

export async function serveItems(db: Db, ctx: Ctx, orderId: string, itemIds?: string[]) {
  const order = await lockOrder(db, ctx, orderId, { allow: ["open", "closed"] });
  const n = await db.exec(
    `UPDATE order_items SET status = 'served', served_at = now() WHERE order_id = $1 AND status = 'ready' AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`, [orderId, itemIds ?? null]);
  if (!n) throw conflict("No ready items to serve", "NOTHING_TO_SERVE");
  await audit(db, ctx, "order.serve", "order", orderId, { items: n }, { orderId, outletId: order.outletId });
  await changed(db, ctx, order.outletId, "kitchen");
  return getOrderView(db, ctx, orderId);
}

export async function requestBill(db: Db, ctx: Ctx, orderId: string) {
  const order = await lockOrder(db, ctx, orderId);
  const hasItems = await db.maybe(`SELECT 1 FROM order_items WHERE order_id = $1 AND status <> 'void' LIMIT 1`, [orderId]);
  if (!hasItems) throw conflict("The order is empty", "ORDER_EMPTY");
  await db.exec(`UPDATE orders SET bill_requested_at = now() WHERE id = $1`, [orderId]);
  await audit(db, ctx, "order.request_bill", "order", orderId, {}, { orderId, outletId: order.outletId });
  await changed(db, ctx, order.outletId, "order");
  return getOrderView(db, ctx, orderId);
}

/* ───────────────────────── Tables: transfer / combine / split ───────────────────────── */
export async function transferTable(db: Db, ctx: Ctx, orderId: string, toTableId: string) {
  const order = await lockOrder(db, ctx, orderId);
  if (order.tableId === toTableId) throw badRequest("The order is already on this table", "SAME_TABLE");
  await assertTableFree(db, toTableId, order.outletId);
  await db.exec(`DELETE FROM order_tables WHERE order_id = $1`, [orderId]);
  // the party moves together: split checks of the same table follow it
  if (order.tableId) await db.exec(`UPDATE order_tables SET table_id = $2 WHERE table_id = $1 AND order_id IN (SELECT id FROM orders WHERE status = 'open')`, [order.tableId, toTableId]);
  try { await db.exec(`UPDATE orders SET table_id = $2 WHERE id = $1`, [orderId, toTableId]); }
  catch (e) { if ((e as { code?: string }).code === "23505") throw conflict("That table was just taken", "TABLE_OCCUPIED"); throw e; }
  await audit(db, ctx, "order.transfer_table", "order", orderId, { from: order.tableId, to: toTableId }, { orderId, outletId: order.outletId });
  await changed(db, ctx, order.outletId, "order");
  return getOrderView(db, ctx, orderId);
}

export async function combineTables(db: Db, ctx: Ctx, orderId: string, tableIds: string[]) {
  const order = await lockOrder(db, ctx, orderId);
  if (!order.tableId) throw badRequest("This order has no table", "NO_TABLE");
  for (const t of tableIds) {
    if (t === order.tableId) continue;
    await assertTableFree(db, t, order.outletId);
    await db.exec(`INSERT INTO order_tables (org_id, order_id, table_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [ctx.orgId, orderId, t]);
  }
  await audit(db, ctx, "order.combine_tables", "order", orderId, { tableIds }, { orderId, outletId: order.outletId });
  await changed(db, ctx, order.outletId, "order");
  return getOrderView(db, ctx, orderId);
}

export async function releaseTable(db: Db, ctx: Ctx, orderId: string, tableId: string) {
  const order = await lockOrder(db, ctx, orderId);
  const n = await db.exec(`DELETE FROM order_tables WHERE order_id = $1 AND table_id = $2`, [orderId, tableId]);
  if (!n) throw badRequest("That table is not combined with this order", "NOT_COMBINED");
  await audit(db, ctx, "order.split_tables", "order", orderId, { tableId }, { orderId, outletId: order.outletId });
  await changed(db, ctx, order.outletId, "order");
  return getOrderView(db, ctx, orderId);
}

/* ───────────────────────── Split / move / merge orders ───────────────────────── */
export const moveItemsSchema = z.object({ itemIds: z.array(z.uuid()).min(1).max(100), toOrderId: z.uuid().optional() });

/** Move items to a new check on the same table (split by item/seat) or to another open order. */
export async function moveItems(db: Db, ctx: Ctx, orderId: string, input: z.infer<typeof moveItemsSchema>) {
  const ids = input.toOrderId ? [orderId, input.toOrderId].sort() : [orderId];
  let src!: OrderRow; let dst: OrderRow | null = null;
  for (const id of ids) { const o = await lockOrder(db, ctx, id); if (id === orderId) src = o; else dst = o; }
  if (input.toOrderId && dst && dst.outletId !== src.outletId) throw badRequest("Orders belong to different outlets", "OUTLET_MISMATCH");
  const items = await db.query<{ id: string; status: string }>(`SELECT id, status FROM order_items WHERE order_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE`, [orderId, input.itemIds]);
  if (items.length !== input.itemIds.length) throw notFound("Item");
  if (items.some((i) => i.status === "void")) throw badRequest("Voided items cannot be moved", "ITEM_VOID");
  let targetId = input.toOrderId;
  if (!targetId) {
    const o = await db.one<{ id: string }>(`SELECT id FROM orders WHERE id = $1`, [orderId]);
    void o;
    const no = await db.one<{ n: number }>(
      `INSERT INTO order_counters (org_id, outlet_id, business_date, last_no) VALUES ($1,$2,$3,1)
       ON CONFLICT (outlet_id, business_date) DO UPDATE SET last_no = order_counters.last_no + 1 RETURNING last_no AS n`, [ctx.orgId, src.outletId, src.businessDate]);
    // the new check shares the table implicitly through order_tables (the unique open-table index belongs to the primary check)
    const n = await db.one<{ id: string }>(
      `INSERT INTO orders (org_id, outlet_id, order_no, business_date, type, table_id, covers, server_id, opened_by, room_ref, note) VALUES ($1,$2,$3,$4,$5,NULL,0,$6,$7,$8,$9) RETURNING id`,
      [ctx.orgId, src.outletId, no.n, src.businessDate, src.type, src.serverId, ctx.employee.id, src.roomRef, `Split from #${src.orderNo}`]);
    targetId = n.id;
    if (src.tableId) await db.exec(`INSERT INTO order_tables (org_id, order_id, table_id) VALUES ($1,$2,$3)`, [ctx.orgId, targetId, src.tableId]);
  }
  await db.exec(`UPDATE order_items SET order_id = $2 WHERE id = ANY($1::uuid[])`, [input.itemIds, targetId]);
  await db.exec(`UPDATE orders SET bill_requested_at = NULL WHERE id IN ($1,$2)`, [orderId, targetId]);
  await audit(db, ctx, input.toOrderId ? "order.move_items" : "order.split", "order", orderId, { itemIds: input.itemIds, toOrderId: targetId }, { orderId, outletId: src.outletId });
  await changed(db, ctx, src.outletId, "order");
  return { from: await getOrderView(db, ctx, orderId), to: await getOrderView(db, ctx, targetId) };
}

export async function mergeOrders(db: Db, ctx: Ctx, sourceId: string, targetId: string) {
  if (sourceId === targetId) throw badRequest("Cannot merge an order with itself", "SAME_ORDER");
  let src!: OrderRow; let dst!: OrderRow;
  for (const id of [sourceId, targetId].sort()) { const o = await lockOrder(db, ctx, id); if (id === sourceId) src = o; else dst = o; }
  if (src.outletId !== dst.outletId) throw badRequest("Orders belong to different outlets", "OUTLET_MISMATCH");
  const paid = await db.maybe(`SELECT 1 FROM payments WHERE order_id = $1 AND status = 'succeeded' LIMIT 1`, [sourceId]);
  if (paid) throw conflict("The source order already has payments", "ORDER_HAS_PAYMENTS");
  await db.exec(`UPDATE order_items SET order_id = $2 WHERE order_id = $1`, [sourceId, targetId]);
  await db.exec(`UPDATE order_discounts SET order_id = $2 WHERE order_id = $1`, [sourceId, targetId]);
  await db.exec(`DELETE FROM order_tables WHERE order_id = $1`, [sourceId]);
  await db.exec(`UPDATE orders SET covers = covers + $2, bill_requested_at = NULL WHERE id = $1`, [targetId, src.covers]);
  await db.exec(`UPDATE orders SET status = 'merged', table_id = NULL, closed_at = now(), closed_by = $2, note = COALESCE(note || ' · ', '') || $3 WHERE id = $1`, [sourceId, ctx.employee.id, `Merged into #${dst.orderNo}`]);
  await audit(db, ctx, "order.merge", "order", sourceId, { into: targetId }, { orderId: sourceId, outletId: src.outletId });
  await audit(db, ctx, "order.merge_target", "order", targetId, { from: sourceId }, { orderId: targetId, outletId: src.outletId });
  await changed(db, ctx, src.outletId, "order");
  return getOrderView(db, ctx, targetId);
}

/* ───────────────────────── Discounts ───────────────────────── */
export const applyDiscountSchema = z.object({
  discountId: z.uuid().optional(),
  custom: z.object({ kind: z.enum(["percent", "amount"]), value: z.number().int().min(1).max(10_000_000), name: z.string().trim().min(1).max(60).default("Custom discount") }).optional(),
  itemId: z.uuid().optional(),
  reason: z.string().trim().min(3, "A reason is required").max(200),
  approval: z.object({ employeeId: z.uuid(), pin: z.string().min(4).max(8) }).optional(),
}).refine((d) => !!d.discountId !== !!d.custom, { message: "Provide either a catalog discount or a custom one" });

export async function applyDiscount(db: Db, ctx: Ctx, orderId: string, input: z.infer<typeof applyDiscountSchema>) {
  const order = await lockOrder(db, ctx, orderId);
  let kind: "percent" | "amount"; let value: number; let name: string; let threshold = 1000; let custom = false;
  if (input.discountId) {
    const d = await db.maybe<{ name: string; kind: "percent" | "amount"; value: number; approvalThresholdBps: number }>(`SELECT name, kind, value, approval_threshold_bps FROM discounts WHERE id = $1 AND active`, [input.discountId]);
    if (!d) throw notFound("Discount");
    ({ kind, value, name } = d); threshold = d.approvalThresholdBps;
  } else { ({ kind, value, name } = input.custom!); custom = true; }
  if (kind === "percent" && value > 10000) throw badRequest("A percentage cannot exceed 100%", "INVALID_DISCOUNT");
  const view = await getOrderView(db, ctx, orderId);
  let base = view.totals.grossCents - view.totals.itemDiscountCents - view.totals.orderDiscountCents;
  let itemGross = 0;
  if (input.itemId) {
    const it = view.items.find((i) => i.id === input.itemId && i.status !== "void");
    if (!it) throw notFound("Item");
    itemGross = it.unitPriceCents * it.qty - it.discountCents; base = itemGross;
  }
  const amount = Math.min(base, kind === "percent" ? bps(base, value) : value);
  if (amount <= 0) throw badRequest("Nothing to discount", "NOTHING_TO_DISCOUNT");
  const effectiveBps = base > 0 ? Math.round((amount * 10000) / base) : 0;
  const needsApproval = custom || effectiveBps > threshold;
  const approver = needsApproval ? await resolveApprover(db, ctx, "discounts.approve", input.approval as ApprovalInput | undefined) : null;
  if (input.itemId) {
    await db.exec(`UPDATE order_items SET discount_cents = discount_cents + $2, discount_reason = $3, discount_approved_by = $4 WHERE id = $1`, [input.itemId, amount, input.reason, approver]);
  } else {
    await db.exec(`INSERT INTO order_discounts (org_id, order_id, discount_id, name, kind, value, reason, applied_by, approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ctx.orgId, orderId, input.discountId ?? null, name, kind, value, input.reason, ctx.employee.id, approver]);
  }
  await audit(db, ctx, "order.discount", "order", orderId, { name, kind, value, amountCents: amount, itemId: input.itemId ?? null, reason: input.reason, custom }, { orderId, outletId: order.outletId, approverId: approver });
  await changed(db, ctx, order.outletId, "order");
  return getOrderView(db, ctx, orderId);
}

export async function removeDiscount(db: Db, ctx: Ctx, orderId: string, discountRowId: string) {
  const order = await lockOrder(db, ctx, orderId);
  const n = await db.exec(`DELETE FROM order_discounts WHERE id = $1 AND order_id = $2`, [discountRowId, orderId]);
  if (!n) throw notFound("Discount");
  await audit(db, ctx, "order.discount_removed", "order", orderId, { discountRowId }, { orderId, outletId: order.outletId });
  await changed(db, ctx, order.outletId, "order");
  return getOrderView(db, ctx, orderId);
}

/* ───────────────────────── Void / reopen ───────────────────────── */
export const reasonApprovalSchema = z.object({
  reason: z.string().trim().min(3, "A reason is required").max(200),
  approval: z.object({ employeeId: z.uuid(), pin: z.string().min(4).max(8) }).optional(),
});

export async function voidOrder(db: Db, ctx: Ctx, orderId: string, input: z.infer<typeof reasonApprovalSchema>) {
  const order = await lockOrder(db, ctx, orderId);
  const paid = await db.maybe(`SELECT 1 FROM payments WHERE order_id = $1 AND status = 'succeeded' LIMIT 1`, [orderId]);
  if (paid) throw conflict("This order has payments. Refund them first.", "ORDER_HAS_PAYMENTS");
  const sentAny = await db.maybe(`SELECT 1 FROM order_items WHERE order_id = $1 AND status NOT IN ('draft','held','void') LIMIT 1`, [orderId]);
  const approver = await resolveApprover(db, ctx, "orders.void", input.approval as ApprovalInput | undefined);
  await db.exec(`UPDATE order_items SET status = 'void', void_reason = $2, voided_by = $3, voided_at = now(), void_approved_by = $4 WHERE order_id = $1 AND status <> 'void'`, [orderId, input.reason, ctx.employee.id, approver]);
  await db.exec(`DELETE FROM order_tables WHERE order_id = $1`, [orderId]);
  await db.exec(`UPDATE orders SET status = 'void', void_reason = $2, closed_at = now(), closed_by = $3, table_id = NULL WHERE id = $1`, [orderId, input.reason, ctx.employee.id]);
  await audit(db, ctx, "order.void", "order", orderId, { reason: input.reason, hadSentItems: !!sentAny }, { orderId, outletId: order.outletId, approverId: approver });
  await enqueueEvent(db, { orgId: ctx.orgId, outletId: order.outletId, key: `order.voided:${orderId}`, type: "order.voided",
    payload: { orderId, orderNo: order.orderNo, businessDate: order.businessDate, reason: input.reason, hadSentItems: !!sentAny } });
  await changed(db, ctx, order.outletId, "order");
  return getOrderView(db, ctx, orderId);
}

export async function reopenOrder(db: Db, ctx: Ctx, orderId: string, input: z.infer<typeof reasonApprovalSchema>) {
  const order = await lockOrder(db, ctx, orderId, { allow: ["closed"] });
  const approver = await resolveApprover(db, ctx, "orders.reopen", input.approval as ApprovalInput | undefined);
  if (await db.maybe(`SELECT 1 FROM day_closes WHERE outlet_id = $1 AND business_date = $2`, [order.outletId, order.businessDate])) throw conflict("The business day of this order is already closed", "DAY_CLOSED");
  if (await db.maybe(`SELECT 1 FROM refunds WHERE order_id = $1 LIMIT 1`, [orderId])) throw conflict("This order has refunds and cannot be reopened", "ORDER_HAS_REFUNDS");
  if (order.tableId && await db.maybe(`SELECT 1 FROM orders WHERE table_id = $1 AND status = 'open'`, [order.tableId])) throw conflict("The table now has another open order", "TABLE_OCCUPIED");
  await db.exec(
    `UPDATE orders SET status = 'open', closed_at = NULL, closed_by = NULL, gross_cents = NULL, item_discount_cents = NULL, order_discount_cents = NULL, service_charge_cents = NULL,
       tax_cents = NULL, total_cents = NULL, net_sales_cents = NULL, totals_snapshot = NULL, tip_cents = 0 WHERE id = $1`, [orderId]);
  await audit(db, ctx, "order.reopen", "order", orderId, { reason: input.reason }, { orderId, outletId: order.outletId, approverId: approver });
  await enqueueEvent(db, { orgId: ctx.orgId, outletId: order.outletId, key: `order.reopened:${orderId}:v${order.version}`, type: "order.reopened",
    payload: { orderId, orderNo: order.orderNo, businessDate: order.businessDate, reason: input.reason } });
  await changed(db, ctx, order.outletId, "order");
  return getOrderView(db, ctx, orderId);
}

/* ───────────────────────── Queries ───────────────────────── */
export async function listOpenOrders(db: Db, ctx: Ctx, outletId: string) {
  await loadOutlet(db, ctx, outletId);
  return db.query<{ id: string; orderNo: number; type: string; tableLabel: string | null; covers: number; serverName: string | null; openedAt: Date; itemCount: number }>(
    `SELECT o.id, o.order_no, o.type, t.label AS table_label, o.covers, e.name AS server_name, o.opened_at,
            (SELECT count(*)::int FROM order_items i WHERE i.order_id = o.id AND i.status <> 'void') AS item_count
       FROM orders o LEFT JOIN tables t ON t.id = o.table_id LEFT JOIN employees e ON e.id = o.server_id
      WHERE o.outlet_id = $1 AND o.status = 'open' ORDER BY o.opened_at`, [outletId]);
}

export const orderSearchSchema = z.object({ outletId: z.uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), status: z.enum(["open", "closed", "void", "merged"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });
export async function searchOrders(db: Db, ctx: Ctx, q: z.infer<typeof orderSearchSchema>) {
  await loadOutlet(db, ctx, q.outletId);
  return db.query<{ id: string; orderNo: number; businessDate: string; type: string; status: string; totalCents: number | null; tipCents: number; closedAt: Date | null; tableLabel: string | null }>(
    `SELECT o.id, o.order_no, o.business_date::text, o.type, o.status, o.total_cents, o.tip_cents, o.closed_at, t.label AS table_label
       FROM orders o LEFT JOIN tables t ON t.id = o.table_id
      WHERE o.outlet_id = $1 AND ($2::date IS NULL OR o.business_date = $2) AND ($3::text IS NULL OR o.status = $3) ORDER BY o.opened_at DESC LIMIT $4`,
    [q.outletId, q.date ?? null, q.status ?? null, q.limit]);
}

