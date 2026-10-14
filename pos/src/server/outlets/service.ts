import { z } from "zod";
import type { Db } from "@/lib/db";
import { assertOutletAccess, type Ctx } from "@/lib/auth";
import { notFound, conflict, badRequest } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { createOutletDefaults } from "@/server/setup/service";

export interface OutletRow {
  id: string; name: string; code: string; timezone: string; pricesIncludeTax: boolean; serviceChargeBps: number; serviceChargeTaxBps: number;
  businessDayStartHour: number; idleLockMinutes: number; tableAlertMinutes: number; address: string | null; phone: string | null;
  taxIdentifier: string | null; receiptHeader: string | null; receiptFooter: string | null; fluentraLocationId: string | null; active: boolean;
}

export async function loadOutlet(db: Db, ctx: Ctx, outletId: string): Promise<OutletRow> {
  assertOutletAccess(ctx, outletId);
  const o = await db.maybe<OutletRow>(`SELECT * FROM outlets WHERE id = $1`, [outletId]);
  if (!o) throw notFound("Outlet");
  return o;
}

export async function listOutlets(db: Db, ctx: Ctx) {
  const rows = await db.query<OutletRow>(`SELECT * FROM outlets ORDER BY name`);
  return rows.filter((o) => (!ctx.outletId || ctx.outletId === o.id) && (!ctx.outletIds || ctx.outletIds.includes(o.id)));
}

export const outletCreateSchema = z.object({ name: z.string().trim().min(2).max(120), timezone: z.string().min(3).max(60).default("Africa/Casablanca") });
export async function createOutlet(db: Db, ctx: Ctx, input: z.infer<typeof outletCreateSchema>) {
  const o = await createOutletDefaults(db, ctx.orgId, input.name, input.timezone);
  await audit(db, ctx, "outlet.create", "outlet", o.id, { name: input.name }, { outletId: o.id });
  return o;
}

export const outletUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  timezone: z.string().min(3).max(60),
  pricesIncludeTax: z.boolean(),
  serviceChargeBps: z.number().int().min(0).max(5000),
  serviceChargeTaxBps: z.number().int().min(0).max(5000),
  businessDayStartHour: z.number().int().min(0).max(12),
  idleLockMinutes: z.number().int().min(1).max(480),
  tableAlertMinutes: z.number().int().min(5).max(600),
  address: z.string().max(300).nullable(), phone: z.string().max(40).nullable(),
  taxIdentifier: z.string().max(60).nullable(),
  receiptHeader: z.string().max(300).nullable(), receiptFooter: z.string().max(300).nullable(),
  fluentraLocationId: z.string().max(80).nullable(),
  active: z.boolean(),
}).partial();

export async function updateOutlet(db: Db, ctx: Ctx, outletId: string, input: z.infer<typeof outletUpdateSchema>) {
  const before = await loadOutlet(db, ctx, outletId);
  if (input.timezone) {
    const ok = await db.maybe(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [input.timezone]);
    if (!ok) throw badRequest("Unknown timezone", "INVALID_TIMEZONE");
  }
  const cols: Record<string, string> = {
    name: "name", timezone: "timezone", pricesIncludeTax: "prices_include_tax", serviceChargeBps: "service_charge_bps", serviceChargeTaxBps: "service_charge_tax_bps",
    businessDayStartHour: "business_day_start_hour", idleLockMinutes: "idle_lock_minutes", tableAlertMinutes: "table_alert_minutes", address: "address", phone: "phone",
    taxIdentifier: "tax_identifier", receiptHeader: "receipt_header", receiptFooter: "receipt_footer", fluentraLocationId: "fluentra_location_id", active: "active",
  };
  const sets: string[] = []; const vals: unknown[] = [outletId];
  const changed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    vals.push(v); sets.push(`${cols[k]} = $${vals.length}`);
    changed[k] = { from: (before as unknown as Record<string, unknown>)[k], to: v };
  }
  if (!sets.length) return before;
  const o = await db.one<OutletRow>(`UPDATE outlets SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, vals);
  await audit(db, ctx, "outlet.update", "outlet", outletId, changed, { outletId });
  return o;
}

/* ───────── Dining rooms, tables, stations ───────── */
export const roomSchema = z.object({ name: z.string().trim().min(1).max(80), sort: z.number().int().min(0).max(1000).optional() });
export async function createRoom(db: Db, ctx: Ctx, outletId: string, input: z.infer<typeof roomSchema>) {
  await loadOutlet(db, ctx, outletId);
  const r = await db.one<{ id: string }>(`INSERT INTO dining_rooms (org_id, outlet_id, name, sort) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.orgId, outletId, input.name, input.sort ?? 0]);
  await audit(db, ctx, "room.create", "dining_room", r.id, { name: input.name }, { outletId });
  return r;
}
export async function updateRoom(db: Db, ctx: Ctx, roomId: string, input: Partial<z.infer<typeof roomSchema>> & { active?: boolean }) {
  const r = await db.maybe<{ outletId: string }>(`SELECT outlet_id FROM dining_rooms WHERE id = $1`, [roomId]);
  if (!r) throw notFound("Room");
  assertOutletAccess(ctx, r.outletId);
  if (input.active === false && await db.maybe(`SELECT 1 FROM orders o JOIN tables t ON t.id=o.table_id WHERE t.dining_room_id=$1 AND o.status='open'`, [roomId])) throw conflict("This room has open orders", "ROOM_IN_USE");
  await db.exec(`UPDATE dining_rooms SET name = COALESCE($2, name), sort = COALESCE($3, sort), active = COALESCE($4, active) WHERE id = $1`, [roomId, input.name ?? null, input.sort ?? null, input.active ?? null]);
  await audit(db, ctx, "room.update", "dining_room", roomId, input, { outletId: r.outletId });
}

export const tableSchema = z.object({
  label: z.string().trim().min(1).max(20),
  seats: z.number().int().min(1).max(60).default(2),
  x: z.number().int().min(0).max(5000).default(0), y: z.number().int().min(0).max(5000).default(0),
  w: z.number().int().min(40).max(500).default(90), h: z.number().int().min(40).max(500).default(90),
  shape: z.enum(["square", "round", "rect"]).default("square"),
  assignedServerId: z.uuid().nullable().optional(),
});
export async function createTable(db: Db, ctx: Ctx, roomId: string, input: z.infer<typeof tableSchema>) {
  const room = await db.maybe<{ outletId: string }>(`SELECT outlet_id FROM dining_rooms WHERE id = $1`, [roomId]);
  if (!room) throw notFound("Room");
  assertOutletAccess(ctx, room.outletId);
  const t = await db.one<{ id: string }>(
    `INSERT INTO tables (org_id, outlet_id, dining_room_id, label, seats, x, y, w, h, shape, assigned_server_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [ctx.orgId, room.outletId, roomId, input.label, input.seats, input.x, input.y, input.w, input.h, input.shape, input.assignedServerId ?? null]);
  await audit(db, ctx, "table.create", "table", t.id, { label: input.label }, { outletId: room.outletId });
  return t;
}
export async function updateTable(db: Db, ctx: Ctx, tableId: string, input: Partial<z.infer<typeof tableSchema>> & { active?: boolean }) {
  const t = await db.maybe<{ outletId: string }>(`SELECT outlet_id FROM tables WHERE id = $1`, [tableId]);
  if (!t) throw notFound("Table");
  assertOutletAccess(ctx, t.outletId);
  if (input.active === false && await db.maybe(`SELECT 1 FROM orders WHERE table_id=$1 AND status='open'`, [tableId])) throw conflict("This table has an open order", "TABLE_IN_USE");
  if (input.assignedServerId) {
    const e = await db.maybe(`SELECT 1 FROM employees WHERE id = $1 AND active`, [input.assignedServerId]);
    if (!e) throw badRequest("Unknown employee", "INVALID_EMPLOYEE");
  }
  await db.exec(
    `UPDATE tables SET label = COALESCE($2,label), seats = COALESCE($3,seats), x = COALESCE($4,x), y = COALESCE($5,y), w = COALESCE($6,w), h = COALESCE($7,h),
       shape = COALESCE($8,shape), active = COALESCE($9,active),
       assigned_server_id = CASE WHEN $10::boolean THEN $11::uuid ELSE assigned_server_id END WHERE id = $1`,
    [tableId, input.label ?? null, input.seats ?? null, input.x ?? null, input.y ?? null, input.w ?? null, input.h ?? null, input.shape ?? null, input.active ?? null,
     input.assignedServerId !== undefined, input.assignedServerId ?? null]);
  await audit(db, ctx, "table.update", "table", tableId, input, { outletId: t.outletId });
}

export const stationSchema = z.object({ name: z.string().trim().min(1).max(60), kind: z.enum(["kitchen", "bar", "pastry"]), targetSeconds: z.number().int().min(30).max(7200).default(600) });
export async function createStation(db: Db, ctx: Ctx, outletId: string, input: z.infer<typeof stationSchema>) {
  await loadOutlet(db, ctx, outletId);
  const s = await db.one<{ id: string }>(`INSERT INTO stations (org_id, outlet_id, name, kind, target_seconds) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ctx.orgId, outletId, input.name, input.kind, input.targetSeconds]);
  await audit(db, ctx, "station.create", "station", s.id, input, { outletId });
  return s;
}
export async function updateStation(db: Db, ctx: Ctx, stationId: string, input: Partial<z.infer<typeof stationSchema>> & { active?: boolean }) {
  const s = await db.maybe<{ outletId: string }>(`SELECT outlet_id FROM stations WHERE id = $1`, [stationId]);
  if (!s) throw notFound("Station");
  assertOutletAccess(ctx, s.outletId);
  await db.exec(`UPDATE stations SET name = COALESCE($2,name), kind = COALESCE($3,kind), target_seconds = COALESCE($4,target_seconds), active = COALESCE($5,active) WHERE id = $1`,
    [stationId, input.name ?? null, input.kind ?? null, input.targetSeconds ?? null, input.active ?? null]);
  await audit(db, ctx, "station.update", "station", stationId, input, { outletId: s.outletId });
}

export async function listRoomsAndTables(db: Db, ctx: Ctx, outletId: string) {
  await loadOutlet(db, ctx, outletId);
  const rooms = await db.query<{ id: string; name: string; sort: number; active: boolean }>(`SELECT id, name, sort, active FROM dining_rooms WHERE outlet_id = $1 ORDER BY sort, name`, [outletId]);
  const tables = await db.query<{ id: string; diningRoomId: string; label: string; seats: number; x: number; y: number; w: number; h: number; shape: string; assignedServerId: string | null; active: boolean }>(
    `SELECT id, dining_room_id, label, seats, x, y, w, h, shape, assigned_server_id, active FROM tables WHERE outlet_id = $1 ORDER BY label`, [outletId]);
  const stations = await db.query<{ id: string; name: string; kind: string; targetSeconds: number; active: boolean }>(`SELECT id, name, kind, target_seconds, active FROM stations WHERE outlet_id = $1 ORDER BY name`, [outletId]);
  return { rooms, tables, stations };
}

/** Live floor: each table with its current open order summary and a derived status. */
export async function floorState(db: Db, ctx: Ctx, outletId: string) {
  const outlet = await loadOutlet(db, ctx, outletId);
  const base = await listRoomsAndTables(db, ctx, outletId);
  const orders = await db.query<{
    id: string; orderNo: number; tableId: string | null; covers: number; serverId: string | null; serverName: string | null; openedAt: Date; billRequestedAt: Date | null;
    sent: number; drafts: number; lastFiredAt: Date | null; type: string;
  }>(
    `SELECT o.id, o.order_no, o.table_id, o.covers, o.server_id, e.name AS server_name, o.opened_at, o.bill_requested_at, o.type,
            count(i.*) FILTER (WHERE i.status NOT IN ('draft','void'))::int AS sent,
            count(i.*) FILTER (WHERE i.status = 'draft')::int AS drafts,
            max(i.fired_at) AS last_fired_at
       FROM orders o LEFT JOIN employees e ON e.id = o.server_id LEFT JOIN order_items i ON i.order_id = o.id
      WHERE o.outlet_id = $1 AND o.status = 'open' GROUP BY o.id, e.name ORDER BY o.opened_at`, [outletId]);
  const extra = await db.query<{ orderId: string; tableId: string }>(`SELECT order_id, table_id FROM order_tables WHERE order_id = ANY($1::uuid[])`, [orders.map((o) => o.id)]);
  // a table can carry several checks (split bills): the primary check is displayed, the status looks at all of them
  const byTable = new Map<string, Array<(typeof orders)[number]>>();
  const add = (tableId: string, o: (typeof orders)[number]) => byTable.set(tableId, [...(byTable.get(tableId) ?? []), o]);
  for (const o of orders) if (o.tableId) add(o.tableId, o);
  for (const x of extra) { const o = orders.find((q) => q.id === x.orderId); if (o) add(x.tableId, o); }
  const now = Date.now();
  const tables = base.tables.map((t) => {
    const checks = byTable.get(t.id) ?? [];
    const o = checks.find((c) => c.tableId === t.id) ?? checks[0];
    const status = !o ? "available" : checks.every((c) => c.billRequestedAt) ? "awaiting_payment" : checks.some((c) => c.sent > 0) ? "ordered" : "occupied";
    const elapsedMin = o ? Math.floor((now - Math.min(...checks.map((c) => c.openedAt.getTime()))) / 60000) : 0;
    return { ...t, status, checks: checks.length, order: o ? { id: o.id, orderNo: o.orderNo, covers: checks.reduce((a, c) => a + c.covers, 0), serverName: o.serverName, openedAt: o.openedAt, elapsedMin, alert: elapsedMin >= outlet.tableAlertMinutes, drafts: o.drafts } : null };
  });
  const noTable = orders.filter((o) => !o.tableId).map((o) => ({ id: o.id, orderNo: o.orderNo, type: o.type, serverName: o.serverName, openedAt: o.openedAt, covers: o.covers, sent: o.sent }));
  return { outlet: { id: outlet.id, name: outlet.name, tableAlertMinutes: outlet.tableAlertMinutes }, rooms: base.rooms, tables, quickOrders: noTable };
}
