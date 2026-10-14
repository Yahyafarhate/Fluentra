import { z } from "zod";
import { notifyChange, type Db } from "@/lib/db";
import { assertOutletAccess, type Ctx } from "@/lib/auth";
import { can } from "@/lib/rbac";
import { conflict, forbidden, notFound } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { loadOutlet } from "@/server/outlets/service";
import { enqueueEvent } from "@/server/integration/events";

export interface CashSession {
  id: string; outletId: string; drawer: string; openedBy: string; openedAt: Date; openingFloatCents: number; status: "open" | "closed";
  closedAt: Date | null; countedCashCents: number | null; expectedCashCents: number | null; varianceCents: number | null;
}

/**
 * Expected cash in the drawer = opening float + cash payments (applied amount + cash tips, change already excluded)
 * + pay-ins − pay-outs − cash refunds. Card/other tenders never touch the drawer.
 */
export async function expectedCash(db: Db, sessionId: string): Promise<{ openingFloatCents: number; cashSalesCents: number; cashTipsCents: number; payInCents: number; payOutCents: number; cashRefundsCents: number; expectedCents: number }> {
  const r = await db.one<{ openingFloatCents: number; sales: number; tips: number; payIn: number; payOut: number; refunds: number }>(
    `SELECT s.opening_float_cents,
            COALESCE((SELECT sum(amount_cents) FROM payments WHERE cash_session_id = s.id AND method = 'cash' AND status = 'succeeded'),0)::int AS sales,
            COALESCE((SELECT sum(tip_cents) FROM payments WHERE cash_session_id = s.id AND method = 'cash' AND status = 'succeeded'),0)::int AS tips,
            COALESCE((SELECT sum(amount_cents) FROM cash_movements WHERE cash_session_id = s.id AND kind = 'pay_in'),0)::int AS pay_in,
            COALESCE((SELECT sum(amount_cents) FROM cash_movements WHERE cash_session_id = s.id AND kind = 'pay_out'),0)::int AS pay_out,
            COALESCE((SELECT sum(amount_cents) FROM refunds WHERE cash_session_id = s.id AND status = 'succeeded'),0)::int AS refunds
       FROM cash_sessions s WHERE s.id = $1`, [sessionId]);
  return { openingFloatCents: r.openingFloatCents, cashSalesCents: r.sales, cashTipsCents: r.tips, payInCents: r.payIn, payOutCents: r.payOut, cashRefundsCents: r.refunds,
    expectedCents: r.openingFloatCents + r.sales + r.tips + r.payIn - r.payOut - r.refunds };
}

export const openSessionSchema = z.object({ outletId: z.uuid(), drawer: z.string().trim().min(1).max(30).default("Main"), openingFloatCents: z.number().int().min(0).max(100_000_000) });

export async function openCashSession(db: Db, ctx: Ctx, input: z.infer<typeof openSessionSchema>) {
  assertOutletAccess(ctx, input.outletId);
  if (!(await db.maybe(`SELECT 1 FROM outlets WHERE id = $1`, [input.outletId]))) throw notFound("Outlet");
  let s: { id: string };
  try {
    s = await db.one<{ id: string }>(`INSERT INTO cash_sessions (org_id, outlet_id, drawer, opened_by, opening_float_cents) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ctx.orgId, input.outletId, input.drawer, ctx.employee.id, input.openingFloatCents]);
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw conflict("This drawer already has an open cash session", "CASH_SESSION_OPEN");
    throw e;
  }
  await audit(db, ctx, "cash.open", "cash_session", s.id, { drawer: input.drawer, openingFloatCents: input.openingFloatCents }, { outletId: input.outletId });
  await notifyChange(db, ctx.orgId, input.outletId, "cash");
  return getCashSession(db, ctx, s.id);
}

export async function getCashSession(db: Db, ctx: Ctx, id: string) {
  const s = await db.maybe<CashSession & { openedByName: string | null }>(
    `SELECT s.id, s.outlet_id, s.drawer, s.opened_by, e.name AS opened_by_name, s.opened_at, s.opening_float_cents, s.status, s.closed_at, s.counted_cash_cents, s.expected_cash_cents, s.variance_cents
       FROM cash_sessions s LEFT JOIN employees e ON e.id = s.opened_by WHERE s.id = $1`, [id]);
  if (!s) throw notFound("Cash session");
  assertOutletAccess(ctx, s.outletId);
  const breakdown = s.status === "open" ? await expectedCash(db, id) : null;
  const movements = await db.query<{ id: string; kind: string; amountCents: number; reason: string; createdAt: Date }>(`SELECT id, kind, amount_cents, reason, created_at FROM cash_movements WHERE cash_session_id = $1 ORDER BY created_at`, [id]);
  return { ...s, breakdown, movements };
}

export async function currentCashSessions(db: Db, ctx: Ctx, outletId: string) {
  await loadOutlet(db, ctx, outletId);
  const rows = await db.query<{ id: string }>(`SELECT id FROM cash_sessions WHERE outlet_id = $1 AND status = 'open' ORDER BY opened_at`, [outletId]);
  return Promise.all(rows.map((r) => getCashSession(db, ctx, r.id)));
}

export const movementSchema = z.object({ kind: z.enum(["pay_in", "pay_out"]), amountCents: z.number().int().min(1).max(100_000_000), reason: z.string().trim().min(3).max(200) });
export async function addCashMovement(db: Db, ctx: Ctx, sessionId: string, input: z.infer<typeof movementSchema>) {
  const s = await db.maybe<{ outletId: string; status: string }>(`SELECT outlet_id, status FROM cash_sessions WHERE id = $1 FOR UPDATE`, [sessionId]);
  if (!s) throw notFound("Cash session");
  assertOutletAccess(ctx, s.outletId);
  if (s.status !== "open") throw conflict("This cash session is closed", "CASH_SESSION_CLOSED");
  if (input.kind === "pay_out") {
    const exp = await expectedCash(db, sessionId);
    if (input.amountCents > exp.expectedCents) throw conflict("The drawer does not hold that much cash", "INSUFFICIENT_CASH");
  }
  const m = await db.one<{ id: string }>(`INSERT INTO cash_movements (org_id, cash_session_id, kind, amount_cents, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.orgId, sessionId, input.kind, input.amountCents, input.reason, ctx.employee.id]);
  await audit(db, ctx, `cash.${input.kind}`, "cash_session", sessionId, { amountCents: input.amountCents, reason: input.reason }, { outletId: s.outletId });
  return m;
}

export const closeSessionSchema = z.object({ countedCashCents: z.number().int().min(0).max(1_000_000_000), note: z.string().trim().max(300).optional() });
export async function closeCashSession(db: Db, ctx: Ctx, sessionId: string, input: z.infer<typeof closeSessionSchema>) {
  const s = await db.maybe<{ outletId: string; status: string; openedBy: string; drawer: string }>(`SELECT outlet_id, status, opened_by, drawer FROM cash_sessions WHERE id = $1 FOR UPDATE`, [sessionId]);
  if (!s) throw notFound("Cash session");
  assertOutletAccess(ctx, s.outletId);
  if (s.status !== "open") throw conflict("This cash session is already closed", "CASH_SESSION_CLOSED");
  if (s.openedBy !== ctx.employee.id && !can(ctx.role, "cash.view_all")) throw forbidden("Only the cashier who opened the drawer or a supervisor can close it", "CASH_SESSION_OWNER");
  const pending = await db.maybe(`SELECT 1 FROM payments WHERE cash_session_id = $1 AND status = 'pending' LIMIT 1`, [sessionId]);
  if (pending) throw conflict("Some payments are still pending", "PENDING_PAYMENTS");
  const exp = await expectedCash(db, sessionId);
  const variance = input.countedCashCents - exp.expectedCents;
  await db.exec(`UPDATE cash_sessions SET status = 'closed', closed_by = $2, closed_at = now(), counted_cash_cents = $3, expected_cash_cents = $4, variance_cents = $5, close_note = $6 WHERE id = $1`,
    [sessionId, ctx.employee.id, input.countedCashCents, exp.expectedCents, variance, input.note ?? null]);
  await audit(db, ctx, "cash.close", "cash_session", sessionId, { countedCashCents: input.countedCashCents, expectedCashCents: exp.expectedCents, varianceCents: variance, note: input.note ?? null }, { outletId: s.outletId });
  await enqueueEvent(db, { orgId: ctx.orgId, outletId: s.outletId, key: `cash_session.closed:${sessionId}`, type: "cash_session.closed",
    payload: { sessionId, drawer: s.drawer, expectedCashCents: exp.expectedCents, countedCashCents: input.countedCashCents, varianceCents: variance } });
  await notifyChange(db, ctx.orgId, s.outletId, "cash");
  return getCashSession(db, ctx, sessionId);
}
