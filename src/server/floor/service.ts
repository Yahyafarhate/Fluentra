import { z } from "zod";
import { notifyChange, type Db } from "@/lib/db";
import { assertLocationAccess, type Ctx } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { badRequest, conflict, notFound, unprocessable } from "@/lib/errors";
import { isDateStr } from "@/lib/time";
import { localDayBounds, utcToLocal } from "@/lib/tz";
import { loadLocation } from "../availability/service";
import { shortCode } from "@/lib/ids";

export const tableInputSchema = z.object({
  locationId: z.string().uuid(),
  floorId: z.string().uuid(),
  sectionId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(30),
  minCapacity: z.number().int().min(1).max(100).default(1),
  capacity: z.number().int().min(1).max(100),
  shape: z.enum(["rect", "round", "square"]).default("rect"),
  x: z.number().int().min(0).max(5000).default(20),
  y: z.number().int().min(0).max(5000).default(20),
  w: z.number().int().min(30).max(600).default(90),
  h: z.number().int().min(30).max(600).default(70),
  rotation: z.number().int().min(0).max(359).default(0),
  bookableOnline: z.boolean().default(true),
});
export const tablePatchSchema = tableInputSchema.omit({ locationId: true }).partial();
export type TableInput = z.infer<typeof tableInputSchema>;

async function locOf(db: Db, ctx: Ctx, id: string, table: string): Promise<string> {
  const r = await db.maybe<{ locationId: string }>(`SELECT location_id FROM ${table} WHERE id=$1 AND org_id=$2`, [id, ctx.orgId]);
  if (!r) throw notFound(table === "tables" ? "Table" : table === "floors" ? "Floor" : "Record");
  assertLocationAccess(ctx, r.locationId);
  return r.locationId;
}

async function assertFloorAndSection(db: Db, ctx: Ctx, locationId: string, floorId?: string, sectionId?: string | null) {
  if (floorId && !(await db.maybe(`SELECT 1 FROM floors WHERE id=$1 AND org_id=$2 AND location_id=$3`, [floorId, ctx.orgId, locationId]))) throw notFound("Floor");
  if (sectionId && !(await db.maybe(`SELECT 1 FROM sections WHERE id=$1 AND org_id=$2 AND location_id=$3`, [sectionId, ctx.orgId, locationId]))) throw notFound("Section");
}

export async function createTable(db: Db, ctx: Ctx, input: TableInput) {
  assertLocationAccess(ctx, input.locationId);
  await loadLocation(db, input.locationId);
  if (input.minCapacity > input.capacity) throw unprocessable("Minimum capacity cannot exceed capacity", "INVALID_CAPACITY");
  await assertFloorAndSection(db, ctx, input.locationId, input.floorId, input.sectionId);
  const w = input.shape === "round" || input.shape === "square" ? Math.max(input.w, input.h) : input.w;
  const h = input.shape === "round" || input.shape === "square" ? w : input.h;
  const row = await db.one<{ id: string }>(
    `INSERT INTO tables (org_id, location_id, floor_id, section_id, name, min_capacity, capacity, shape, x, y, w, h, rotation, bookable_online)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [ctx.orgId, input.locationId, input.floorId, input.sectionId ?? null, input.name, input.minCapacity, input.capacity, input.shape, input.x, input.y, w, h, input.rotation, input.bookableOnline]);
  await audit(db, ctx, "table.create", "table", row.id, { name: input.name, capacity: input.capacity });
  await notifyChange(db, ctx.orgId, input.locationId, "floor");
  return row;
}

export async function updateTable(db: Db, ctx: Ctx, id: string, patch: z.infer<typeof tablePatchSchema>) {
  const locationId = await locOf(db, ctx, id, "tables");
  const cur = await db.one<{ minCapacity: number; capacity: number; floorId: string }>(`SELECT min_capacity, capacity, floor_id FROM tables WHERE id=$1 FOR UPDATE`, [id]);
  const minC = patch.minCapacity ?? cur.minCapacity, cap = patch.capacity ?? cur.capacity;
  if (minC > cap) throw unprocessable("Minimum capacity cannot exceed capacity", "INVALID_CAPACITY");
  await assertFloorAndSection(db, ctx, locationId, patch.floorId, patch.sectionId);
  if (patch.capacity !== undefined && patch.capacity < cur.capacity) {
    const future = await db.maybe(
      `SELECT 1 FROM reservation_tables rt JOIN reservations r ON r.id=rt.reservation_id
        WHERE rt.table_id=$1 AND r.status IN ('pending','confirmed','arrived','seated') AND r.party_size > $2 AND upper(rt.during) > now() LIMIT 1`, [id, patch.capacity]);
    if (future) throw conflict("Upcoming reservations exceed the new capacity — reassign them first", "CAPACITY_IN_USE");
  }
  const map: Record<string, string> = { floorId: "floor_id", sectionId: "section_id", name: "name", minCapacity: "min_capacity", capacity: "capacity", shape: "shape", x: "x", y: "y", w: "w", h: "h", rotation: "rotation", bookableOnline: "bookable_online" };
  const sets: string[] = []; const params: unknown[] = [id];
  for (const [k, col] of Object.entries(map)) if ((patch as Record<string, unknown>)[k] !== undefined) { params.push((patch as Record<string, unknown>)[k]); sets.push(`${col}=$${params.length}`); }
  if (!sets.length) return;
  await db.exec(`UPDATE tables SET ${sets.join(",")} WHERE id=$1`, params);
  await audit(db, ctx, "table.update", "table", id, { fields: Object.keys(patch) });
  await notifyChange(db, ctx.orgId, locationId, "floor");
}

export const layoutSchema = z.object({
  locationId: z.string().uuid(),
  tables: z.array(z.object({ id: z.string().uuid(), x: z.number().int().min(0).max(5000), y: z.number().int().min(0).max(5000), w: z.number().int().min(30).max(600), h: z.number().int().min(30).max(600), rotation: z.number().int().min(0).max(359), floorId: z.string().uuid().optional() })).max(500),
});

/** Persist the whole layout atomically (positions, sizes, rotation, floor). */
export async function saveLayout(db: Db, ctx: Ctx, input: z.infer<typeof layoutSchema>) {
  assertLocationAccess(ctx, input.locationId);
  for (const t of input.tables) {
    const n = await db.exec(`UPDATE tables SET x=$3, y=$4, w=$5, h=$6, rotation=$7, floor_id=COALESCE($8, floor_id) WHERE id=$1 AND org_id=$2 AND location_id=$9`,
      [t.id, ctx.orgId, t.x, t.y, t.w, t.h, t.rotation, t.floorId ?? null, input.locationId]);
    if (!n) throw notFound("Table");
  }
  await audit(db, ctx, "floor.layout_saved", "location", input.locationId, { tables: input.tables.length });
  await notifyChange(db, ctx.orgId, input.locationId, "floor");
}

export async function deleteTable(db: Db, ctx: Ctx, id: string) {
  const locationId = await locOf(db, ctx, id, "tables");
  const active = await db.maybe(`SELECT 1 FROM reservation_tables rt JOIN reservations r ON r.id=rt.reservation_id WHERE rt.table_id=$1 AND r.status IN ('pending','confirmed','arrived','seated') LIMIT 1`, [id]);
  if (active) throw conflict("This table has active or upcoming reservations. Reassign them before removing the table.", "TABLE_IN_USE");
  const hist = await db.maybe(`SELECT 1 FROM reservation_tables WHERE table_id=$1 LIMIT 1`, [id]);
  if (hist) await db.exec(`UPDATE tables SET active=false, name = name || ' ~' || $2 WHERE id=$1`, [id, shortCode(4)]);
  else await db.exec(`DELETE FROM tables WHERE id=$1`, [id]);
  await db.exec(`UPDATE table_combinations SET active=false WHERE id IN (SELECT combination_id FROM table_combination_tables WHERE table_id=$1)`, [id]);
  await audit(db, ctx, "table.delete", "table", id, { archived: !!hist });
  await notifyChange(db, ctx.orgId, locationId, "floor");
}

/** Operational table status changes (mark ready, block, unblock). 'occupied' is only ever set by seating a reservation. */
export const tableStatusSchema = z.object({ status: z.enum(["available", "cleaning", "blocked"]), reason: z.string().trim().max(200).optional() });
export async function setTableStatus(db: Db, ctx: Ctx, id: string, input: z.infer<typeof tableStatusSchema>) {
  const locationId = await locOf(db, ctx, id, "tables");
  const t = await db.one<{ status: string; name: string }>(`SELECT status, name FROM tables WHERE id=$1 FOR UPDATE`, [id]);
  if (t.status === "occupied") throw conflict(`Table ${t.name} is occupied by a seated party — complete that visit first`, "TABLE_OCCUPIED");
  if (input.status === "available" && t.status === "blocked") { /* unblock */ }
  await db.exec(`UPDATE tables SET status=$2, blocked_reason=$3 WHERE id=$1`, [id, input.status, input.status === "blocked" ? input.reason ?? null : null]);
  await audit(db, ctx, `table.${input.status === "available" ? (t.status === "cleaning" ? "ready" : "unblock") : input.status}`, "table", id, { from: t.status });
  await notifyChange(db, ctx.orgId, locationId, "floor");
}

// ── floors / sections / combinations ──
export const floorSchema = z.object({ locationId: z.string().uuid(), name: z.string().trim().min(1).max(60), width: z.number().int().min(400).max(3000).default(1000), height: z.number().int().min(300).max(2000).default(640) });
export async function createFloor(db: Db, ctx: Ctx, input: z.infer<typeof floorSchema>) {
  assertLocationAccess(ctx, input.locationId);
  await loadLocation(db, input.locationId);
  const row = await db.one<{ id: string }>(
    `INSERT INTO floors (org_id, location_id, name, width, height, sort) VALUES ($1,$2,$3,$4,$5,(SELECT COALESCE(max(sort),0)+1 FROM floors WHERE location_id=$2)) RETURNING id`,
    [ctx.orgId, input.locationId, input.name, input.width, input.height]);
  await audit(db, ctx, "floor.create", "floor", row.id, { name: input.name });
  return row;
}
export async function updateFloor(db: Db, ctx: Ctx, id: string, patch: Partial<z.infer<typeof floorSchema>>) {
  await locOf(db, ctx, id, "floors");
  await db.exec(`UPDATE floors SET name=COALESCE($2,name), width=COALESCE($3,width), height=COALESCE($4,height) WHERE id=$1`, [id, patch.name ?? null, patch.width ?? null, patch.height ?? null]);
  await audit(db, ctx, "floor.update", "floor", id);
}
export async function deleteFloor(db: Db, ctx: Ctx, id: string) {
  const loc = await locOf(db, ctx, id, "floors");
  const n = await db.one<{ n: number }>(`SELECT count(*)::int n FROM tables WHERE floor_id=$1`, [id]);
  if (n.n > 0) throw conflict("Remove or move this floor's tables first", "FLOOR_NOT_EMPTY");
  await db.exec(`DELETE FROM floors WHERE id=$1`, [id]);
  await audit(db, ctx, "floor.delete", "floor", id);
  await notifyChange(db, ctx.orgId, loc, "floor");
}

export const sectionSchema = z.object({ locationId: z.string().uuid(), name: z.string().trim().min(1).max(60), kind: z.enum(["indoor", "outdoor", "private", "bar", "terrace"]).default("indoor") });
export async function createSection(db: Db, ctx: Ctx, input: z.infer<typeof sectionSchema>) {
  assertLocationAccess(ctx, input.locationId);
  const row = await db.one<{ id: string }>(`INSERT INTO sections (org_id, location_id, name, kind) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.orgId, input.locationId, input.name, input.kind]);
  await audit(db, ctx, "section.create", "section", row.id, { name: input.name });
  return row;
}
export async function deleteSection(db: Db, ctx: Ctx, id: string) {
  await locOf(db, ctx, id, "sections");
  await db.exec(`DELETE FROM sections WHERE id=$1`, [id]);
  await audit(db, ctx, "section.delete", "section", id);
}

export const comboSchema = z.object({ locationId: z.string().uuid(), name: z.string().trim().min(1).max(60), tableIds: z.array(z.string().uuid()).min(2).max(8), capacity: z.number().int().min(2).max(200), minCapacity: z.number().int().min(1).default(1) });
export async function createCombination(db: Db, ctx: Ctx, input: z.infer<typeof comboSchema>) {
  assertLocationAccess(ctx, input.locationId);
  const found = await db.query<{ id: string }>(`SELECT id FROM tables WHERE org_id=$1 AND location_id=$2 AND id = ANY($3) AND active`, [ctx.orgId, input.locationId, input.tableIds]);
  if (found.length !== new Set(input.tableIds).size) throw badRequest("All tables must belong to this location", "INVALID_TABLES");
  const row = await db.one<{ id: string }>(`INSERT INTO table_combinations (org_id, location_id, name, capacity, min_capacity) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ctx.orgId, input.locationId, input.name, input.capacity, input.minCapacity]);
  for (const tid of new Set(input.tableIds)) await db.exec(`INSERT INTO table_combination_tables (combination_id, table_id, org_id) VALUES ($1,$2,$3)`, [row.id, tid, ctx.orgId]);
  await audit(db, ctx, "combination.create", "table_combination", row.id, { name: input.name });
  await notifyChange(db, ctx.orgId, input.locationId, "floor");
  return row;
}
export async function deleteCombination(db: Db, ctx: Ctx, id: string) {
  const loc = await locOf(db, ctx, id, "table_combinations");
  await db.exec(`DELETE FROM table_combinations WHERE id=$1`, [id]);
  await audit(db, ctx, "combination.delete", "table_combination", id);
  await notifyChange(db, ctx.orgId, loc, "floor");
}

// ── Live floor state ──
export type DisplayStatus = "available" | "reserved" | "occupied" | "cleaning" | "blocked" | "unavailable";

export interface FloorTable {
  id: string; floorId: string; sectionId: string | null; name: string; minCapacity: number; capacity: number; shape: "rect" | "round" | "square";
  x: number; y: number; w: number; h: number; rotation: number; status: string; blockedReason: string | null; bookableOnline: boolean; active: boolean;
  displayStatus: DisplayStatus;
  current: null | { id: string; code: string; guestName: string; partySize: number; startAt: Date; endAt: Date; status: string; isVip: boolean; seatedAt: Date | null; specialRequests: string | null };
  next: null | { id: string; code: string; guestName: string; partySize: number; startAt: Date; endAt: Date; status: string; isVip: boolean; seatedAt: Date | null; specialRequests: string | null };
  nextCount: number;
}

export async function getFloorState(db: Db, ctx: Ctx, locationId: string, opts: { at?: Date; horizonMin?: number } = {}) {
  assertLocationAccess(ctx, locationId);
  const loc = await loadLocation(db, locationId);
  const at = opts.at ?? new Date();
  const horizon = opts.horizonMin ?? 90;
  const floors = await db.query(`SELECT id, name, width, height, sort FROM floors WHERE org_id=$1 AND location_id=$2 ORDER BY sort, name`, [ctx.orgId, locationId]);
  const sections = await db.query(`SELECT id, name, kind FROM sections WHERE org_id=$1 AND location_id=$2 ORDER BY sort, name`, [ctx.orgId, locationId]);
  const tables = await db.query<Record<string, any>>( // eslint-disable-line @typescript-eslint/no-explicit-any
    `SELECT id, floor_id, section_id, name, min_capacity, capacity, shape, x, y, w, h, rotation, status, blocked_reason, bookable_online, active
       FROM tables WHERE org_id=$1 AND location_id=$2 AND active ORDER BY name`, [ctx.orgId, locationId]);
  const rs = await db.query<{ tableId: string; id: string; guestName: string; partySize: number; startAt: Date; endAt: Date; status: string; isVip: boolean; seatedAt: Date | null; code: string; specialRequests: string | null }>(
    `SELECT rt.table_id, r.id, r.guest_name, r.party_size, r.start_at, r.end_at, r.status, r.is_vip, r.seated_at, r.code, r.special_requests
       FROM reservation_tables rt JOIN reservations r ON r.id=rt.reservation_id
      WHERE rt.location_id=$1 AND r.status IN ('pending','confirmed','arrived','seated') AND upper(rt.during) > $2 AND lower(rt.during) < $3
      ORDER BY r.start_at`, [locationId, new Date(at.getTime() - 4 * 3600_000), new Date(at.getTime() + 24 * 3600_000)]);
  const combos = await db.query(`SELECT c.id, c.name, c.capacity, array_agg(ct.table_id) AS table_ids FROM table_combinations c JOIN table_combination_tables ct ON ct.combination_id=c.id WHERE c.org_id=$1 AND c.location_id=$2 AND c.active GROUP BY c.id`, [ctx.orgId, locationId]);

  const out: FloorTable[] = tables.map((t) => {
    const mine = rs.filter((r) => r.tableId === t.id);
    const current = mine.find((r) => r.status === "seated") ?? null;
    const arrived = mine.find((r) => r.status === "arrived") ?? null;
    const upcoming = mine.filter((r) => r.status !== "seated" && r.startAt.getTime() >= at.getTime() - 30 * 60_000).sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    const inWindow = upcoming.find((r) => r.startAt.getTime() <= at.getTime() + horizon * 60_000) ?? null;
    let display: DisplayStatus = "available";
    if (t.status === "blocked") display = "blocked";
    else if (t.status === "occupied") display = "occupied";
    else if (t.status === "cleaning") display = "cleaning";
    else if (inWindow || arrived) display = "reserved";
    const pick = (r: typeof current) => r && { id: r.id, code: r.code, guestName: r.guestName, partySize: r.partySize, startAt: r.startAt, endAt: r.endAt, status: r.status, isVip: r.isVip, seatedAt: r.seatedAt, specialRequests: r.specialRequests };
    return { ...(t as unknown as FloorTable), displayStatus: display, current: pick(current) ?? null, next: pick(arrived ?? upcoming[0] ?? null) ?? null, nextCount: upcoming.length };
  });
  return { location: { id: loc.id, name: loc.name, timezone: loc.timezone, cleaningWorkflow: loc.cleaningWorkflow }, at, floors, sections, tables: out, combos };
}

export const timelineQuery = z.object({ locationId: z.string().uuid(), date: z.string().refine(isDateStr) });
export async function getTimeline(db: Db, ctx: Ctx, locationId: string, date: string) {
  assertLocationAccess(ctx, locationId);
  const loc = await loadLocation(db, locationId);
  const [from, to] = await localDayBounds(db, date, loc.timezone);
  const tables = await db.query(`SELECT t.id, t.name, t.capacity, t.section_id, s.name AS section_name FROM tables t LEFT JOIN sections s ON s.id=t.section_id WHERE t.org_id=$1 AND t.location_id=$2 AND t.active ORDER BY t.name`, [ctx.orgId, locationId]);
  const blocks = await db.query(
    `SELECT rt.table_id, r.id, r.code, r.guest_name, r.party_size, r.status, r.is_vip, lower(rt.during) AS start_at, upper(rt.during) AS end_at
       FROM reservation_tables rt JOIN reservations r ON r.id=rt.reservation_id
      WHERE rt.location_id=$1 AND rt.during && tstzrange($2,$3) AND r.status IN ('pending','confirmed','arrived','seated','completed') ORDER BY lower(rt.during)`, [locationId, from, to]);
  return { date, timezone: loc.timezone, dayStart: from, dayEnd: to, tables, blocks, nowLabel: (await utcToLocal(db, new Date(), loc.timezone)).time };
}
