import { z } from "zod";
import { notifyChange, type Db } from "@/lib/db";
import { assertOutletAccess, type Ctx } from "@/lib/auth";
import { conflict, notFound } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { loadOutlet } from "@/server/outlets/service";
import { enqueueEvent } from "@/server/integration/events";

interface StationRow { id: string; outletId: string; name: string; kind: "kitchen" | "bar" | "pastry"; targetSeconds: number; active: boolean }

async function loadStation(db: Db, ctx: Ctx, stationId: string): Promise<StationRow> {
  const s = await db.maybe<StationRow>(`SELECT id, outlet_id, name, kind, target_seconds, active FROM stations WHERE id = $1`, [stationId]);
  if (!s) throw notFound("Station");
  assertOutletAccess(ctx, s.outletId);
  return s;
}

export const listStations = async (db: Db, ctx: Ctx, outletId: string) => {
  await loadOutlet(db, ctx, outletId);
  return db.query<StationRow>(`SELECT id, outlet_id, name, kind, target_seconds, active FROM stations WHERE outlet_id = $1 AND active ORDER BY name`, [outletId]);
};

export type TicketLevel = "ok" | "warn" | "late";
export interface TicketItem {
  id: string; name: string; qty: number; status: string; course: number; seat: number | null; note: string | null; allergyNote: string | null;
  modifiers: string[]; firedAt: Date | null; cancelled: boolean;
}
export interface Ticket {
  orderId: string; orderNo: number; type: string; tableLabel: string | null; covers: number; serverName: string | null;
  firedAt: Date; elapsedSec: number; level: TicketLevel; hasAllergy: boolean; allItemsReady: boolean; items: TicketItem[];
}

/** Station board: tickets with items awaiting preparation, plus recently completed tickets for recall. */
export async function stationBoard(db: Db, ctx: Ctx, stationId: string) {
  const st = await loadStation(db, ctx, stationId);
  const rows = await db.query<{
    id: string; orderId: string; name: string; qty: number; status: string; course: number; seat: number | null; note: string | null; allergyNote: string | null;
    firedAt: Date | null; voidedAt: Date | null; orderNo: number; type: string; covers: number; tableLabel: string | null; serverName: string | null; orderStatus: string; readyAt: Date | null;
  }>(
    `SELECT i.id, i.order_id, i.name, i.qty, i.status, i.course, i.seat, i.note, i.allergy_note, i.fired_at, i.voided_at, i.ready_at,
            o.order_no, o.type, o.covers, t.label AS table_label, e.name AS server_name, o.status AS order_status
       FROM order_items i JOIN orders o ON o.id = i.order_id LEFT JOIN tables t ON t.id = o.table_id LEFT JOIN employees e ON e.id = o.server_id
      WHERE o.outlet_id = $1 AND i.station_kind = $2 AND i.fired_at IS NOT NULL AND o.status IN ('open','closed')
        AND (i.status IN ('fired','accepted','preparing','ready')
             OR (i.status = 'void' AND i.voided_at > now() - interval '10 minutes')
             OR (i.status = 'served' AND i.served_at > now() - interval '30 minutes'))
      ORDER BY i.fired_at`, [st.outletId, st.kind]);
  const mods = rows.length
    ? await db.query<{ orderItemId: string; name: string }>(`SELECT order_item_id, name FROM order_item_modifiers WHERE order_item_id = ANY($1::uuid[])`, [rows.map((r) => r.id)])
    : [];
  const now = Date.now();
  const byOrder = new Map<string, typeof rows>();
  for (const r of rows) byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r]);
  const active: Ticket[] = []; const done: Ticket[] = [];
  for (const [orderId, items] of byOrder) {
    const first = items[0];
    const open = items.filter((i) => ["fired", "accepted", "preparing", "ready"].includes(i.status));
    const firedAt = (open[0] ?? first).firedAt!;
    const elapsedSec = Math.floor((now - firedAt.getTime()) / 1000);
    const level: TicketLevel = elapsedSec >= st.targetSeconds * 1.5 ? "late" : elapsedSec >= st.targetSeconds ? "warn" : "ok";
    const ticket: Ticket = {
      orderId, orderNo: first.orderNo, type: first.type, tableLabel: first.tableLabel, covers: first.covers, serverName: first.serverName, firedAt, elapsedSec, level,
      hasAllergy: items.some((i) => !!i.allergyNote), allItemsReady: open.length > 0 && open.every((i) => i.status === "ready"),
      items: items.map((i) => ({ id: i.id, name: i.name, qty: i.qty, status: i.status, course: i.course, seat: i.seat, note: i.note, allergyNote: i.allergyNote,
        modifiers: mods.filter((m) => m.orderItemId === i.id).map((m) => m.name), firedAt: i.firedAt, cancelled: i.status === "void" })),
    };
    (open.length ? active : done).push(ticket);
  }
  return { station: { id: st.id, name: st.name, kind: st.kind, targetSeconds: st.targetSeconds }, tickets: active, recent: done.slice(-15).reverse() };
}

export const kdsActionSchema = z.object({
  action: z.enum(["accept", "start", "ready", "recall"]),
  itemIds: z.array(z.uuid()).min(1).max(100).optional(),
  orderId: z.uuid().optional(),   // ticket-level: every eligible item of this order at the station
}).refine((v) => !!v.itemIds !== !!v.orderId, { message: "Provide itemIds or orderId" });

const TRANSITIONS: Record<string, { from: string[]; to: string; set: string }> = {
  accept: { from: ["fired"], to: "accepted", set: "accepted_at = now()" },
  start: { from: ["fired", "accepted"], to: "preparing", set: "started_at = COALESCE(started_at, now())" },
  ready: { from: ["fired", "accepted", "preparing"], to: "ready", set: "ready_at = now()" },
  recall: { from: ["ready", "served"], to: "preparing", set: "ready_at = NULL, served_at = NULL" },
};

export async function kdsAction(db: Db, ctx: Ctx, stationId: string, input: z.infer<typeof kdsActionSchema>) {
  const st = await loadStation(db, ctx, stationId);
  const tr = TRANSITIONS[input.action];
  const targets = await db.query<{ id: string; orderId: string; status: string; firedAt: Date | null }>(
    `SELECT i.id, i.order_id, i.status, i.fired_at FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.outlet_id = $1 AND i.station_kind = $2 AND ($3::uuid[] IS NULL OR i.id = ANY($3::uuid[])) AND ($4::uuid IS NULL OR i.order_id = $4)
        AND o.status IN ('open','closed') FOR UPDATE OF i`, [st.outletId, st.kind, input.itemIds ?? null, input.orderId ?? null]);
  if (input.itemIds && targets.length !== input.itemIds.length) throw notFound("Item");
  const eligible = targets.filter((t) => tr.from.includes(t.status));
  if (input.itemIds && eligible.length !== targets.length) throw conflict(`Cannot ${input.action}: item is not in a valid state (${targets.find((t) => !tr.from.includes(t.status))?.status})`, "INVALID_TRANSITION");
  if (!eligible.length) throw conflict(`Nothing to ${input.action}`, "NOTHING_TO_DO");
  await db.exec(`UPDATE order_items SET status = $2, ${tr.set} WHERE id = ANY($1::uuid[])`, [eligible.map((e) => e.id), tr.to]);
  if (input.action === "ready") {
    for (const e of eligible) {
      const actual = e.firedAt ? Math.floor((Date.now() - e.firedAt.getTime()) / 1000) : 0;
      if (actual > st.targetSeconds) {
        await enqueueEvent(db, { orgId: ctx.orgId, outletId: st.outletId, key: `kitchen.delay:${e.id}`, type: "kitchen.delay",
          payload: { itemId: e.id, orderId: e.orderId, station: st.kind, targetSeconds: st.targetSeconds, actualSeconds: actual } });
      }
    }
  }
  const orderIds = [...new Set(eligible.map((e) => e.orderId))];
  for (const oid of orderIds) await audit(db, ctx, `kds.${input.action}`, "order", oid, { station: st.name, items: eligible.filter((e) => e.orderId === oid).length }, { orderId: oid, outletId: st.outletId });
  await notifyChange(db, ctx.orgId, st.outletId, "kitchen");
  return { updated: eligible.length };
}
