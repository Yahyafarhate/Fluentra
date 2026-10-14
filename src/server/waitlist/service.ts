import { z } from "zod";
import { withSystem, withOrg, notifyChange, type Db } from "@/lib/db";
import { assertLocationAccess, type Ctx } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { conflict, forbidden, notFound, badRequest } from "@/lib/errors";
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import { randomToken, sha256 } from "@/lib/ids";
import { loadLocation, loadTables, loadBusy, type LocationRow } from "../availability/service";
import { durationFor, isFree, type BusyInterval, type ComboLite, type TableLite } from "../availability/engine";
import { resolveCustomer } from "../customers/service";
import { dispatchEvent } from "../automation/service";
import { requireFeature } from "../billing/limits";
import { seatWalkIn } from "../reservations/service";

export const waitlistInputSchema = z.object({
  locationId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(32).optional().nullable().or(z.literal("")),
  email: z.string().trim().email().max(200).optional().nullable().or(z.literal("")),
  partySize: z.number().int().min(1).max(100),
  seatingPreference: z.string().trim().max(200).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  priorityReason: z.enum(["accessibility", "reservation_commitment", "vip", "other"]).optional().nullable(),
  consent: z.object({ sms: z.boolean().optional(), email: z.boolean().optional(), whatsapp: z.boolean().optional() }).optional(),
});
export type WaitlistInput = z.infer<typeof waitlistInputSchema>;

const priorityOf = (loc: LocationRow, reason?: string | null) => (reason ? (loc.waitlistPriority[reason] ?? (reason === "vip" ? 1 : 0)) : 0);

export interface WaitEstimate { minutes: number | null; basis: "historical" | "rules"; samples: number }

/** Median real seating duration for a party size over the last 60 days (needs >= 10 samples) else configured duration rules. */
async function seatingDuration(db: Db, loc: LocationRow, party: number): Promise<{ minutes: number; basis: "historical" | "rules"; samples: number }> {
  const rows = await db.query<{ mins: number }>(
    `SELECT extract(epoch FROM (left_at - seated_at))/60 AS mins FROM visits
      WHERE location_id=$1 AND left_at IS NOT NULL AND seated_at > now() - interval '60 days'
        AND party_size BETWEEN $2 AND $3 AND left_at > seated_at`, [loc.id, Math.max(1, party - 1), party + 1]);
  const mins = rows.map((r) => r.mins).filter((m) => m >= 15 && m <= 360).sort((a, b) => a - b);
  if (mins.length >= 10) return { minutes: Math.round(mins[Math.floor(mins.length / 2)]), basis: "historical", samples: mins.length };
  return { minutes: durationFor(loc.durationRules, party), basis: "rules", samples: mins.length };
}

/**
 * Estimate = simulation over real table availability: parties ahead (by priority, then arrival) take the earliest table that fits,
 * then the new party takes the earliest remaining slot. It is an ESTIMATE — never a guaranteed seating time.
 */
export function simulateWait(args: {
  now: number; tables: TableLite[]; combos: ComboLite[]; busy: BusyInterval[]; durationMin: (party: number) => number; bufferMin: number;
  ahead: number[]; party: number;
}): number | null {
  const busy = [...args.busy];
  const usable = args.tables.filter((t) => t.active && t.status !== "blocked");
  const candidates = [...usable.map((t) => ({ ids: [t.id], cap: t.capacity, min: t.minCapacity })), ...args.combos.filter((c) => c.tableIds.every((id) => usable.some((t) => t.id === id))).map((c) => ({ ids: c.tableIds, cap: c.capacity, min: c.minCapacity }))];
  const earliest = (party: number): { at: number; ids: string[] } | null => {
    const dur = (args.durationMin(party) + args.bufferMin) * 60_000;
    let best: { at: number; ids: string[] } | null = null;
    for (const c of candidates) {
      if (c.cap < party || c.min > party) continue;
      // candidate start times: now and the end of each busy interval on these tables
      const starts = new Set<number>([args.now]);
      for (const b of busy) if (c.ids.includes(b.tableId) && b.end > args.now) starts.add(b.end);
      for (const s of [...starts].sort((a, b) => a - b)) {
        if (c.ids.every((id) => isFree(id, s, s + dur, busy))) { if (!best || s < best.at) best = { at: s, ids: c.ids }; break; }
      }
    }
    return best;
  };
  for (const p of args.ahead) {
    const e = earliest(p);
    if (e) for (const id of e.ids) busy.push({ tableId: id, start: e.at, end: e.at + (args.durationMin(p) + args.bufferMin) * 60_000 });
  }
  const mine = earliest(args.party);
  if (!mine) return null;
  return Math.max(0, Math.round((mine.at - args.now) / 60_000 / 5) * 5);
}

export async function estimateWait(db: Db, loc: LocationRow, party: number, aheadParties?: number[]): Promise<WaitEstimate> {
  const now = new Date();
  const { tables, combos } = await loadTables(db, loc.id);
  const busy = await loadBusy(db, loc.id, new Date(now.getTime() - 3600_000), new Date(now.getTime() + 8 * 3600_000), { now });
  // physically occupied / being cleaned tables are not free "now" even without an overlapping reservation
  for (const t of tables) if (t.status === "cleaning") busy.push({ tableId: t.id, start: now.getTime(), end: now.getTime() + 10 * 60_000 });
  const ahead = aheadParties ?? (await db.query<{ partySize: number }>(
    `SELECT party_size FROM waitlist_entries WHERE location_id=$1 AND status IN ('waiting','notified') ORDER BY priority DESC, joined_at`, [loc.id])).map((r) => r.partySize);
  const dur = await seatingDuration(db, loc, party);
  const minutes = simulateWait({ now: now.getTime(), tables, combos, busy, durationMin: (p) => durationFor(loc.durationRules, p), bufferMin: loc.bufferMin, ahead, party });
  return { minutes, basis: dur.basis, samples: dur.samples };
}

async function createEntry(db: Db, orgId: string, input: WaitlistInput, source: "staff" | "online", createdBy: string | null) {
  const loc = await loadLocation(db, input.locationId);
  if (!loc.waitlistEnabled) throw forbidden("The waitlist is not enabled for this restaurant", "WAITLIST_DISABLED");
  if (input.partySize > loc.maxParty) throw badRequest("Party size is above the maximum", "PARTY_TOO_LARGE");
  const phone = normalizePhone(input.phone || null);
  if (input.phone && !phone) throw badRequest("Invalid phone number", "INVALID_PHONE");
  const email = normalizeEmail(input.email || null);
  if (source === "online" && !phone && !email) throw badRequest("A phone number or email is required", "CONTACT_REQUIRED");
  if (phone) {
    const dupe = await db.maybe(`SELECT 1 FROM waitlist_entries WHERE location_id=$1 AND phone=$2 AND status IN ('waiting','notified')`, [loc.id, phone]);
    if (dupe) throw conflict("This guest is already on the waitlist", "DUPLICATE_WAITLIST");
  }
  let customerId: string | null = null;
  if (phone || email) customerId = (await resolveCustomer(db, orgId, { name: input.name, phone, email, source: source === "online" ? "online" : "staff", consent: input.consent, createdBy })).id;
  const est = await estimateWait(db, loc, input.partySize);
  const token = source === "online" ? randomToken(24) : null;
  const priority = priorityOf(loc, input.priorityReason);
  const row = await db.one<{ id: string }>(
    `INSERT INTO waitlist_entries (org_id, location_id, customer_id, name, phone, email, party_size, priority, priority_reason, seating_preference, notes, source, quoted_wait_min, public_token_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [orgId, loc.id, customerId, input.name, phone, email, input.partySize, priority, input.priorityReason ?? null, input.seatingPreference ?? null, input.notes ?? null, source, est.minutes, token ? sha256(token) : null]);
  await notifyChange(db, orgId, loc.id, "waitlist");
  return { id: row.id, token, estimate: est };
}

export async function addToWaitlist(db: Db, ctx: Ctx, input: WaitlistInput) {
  assertLocationAccess(ctx, input.locationId);
  await requireFeature(db, ctx.orgId, "waitlist");
  const r = await createEntry(db, ctx.orgId, input, "staff", ctx.user.id);
  await audit(db, ctx, "waitlist.add", "waitlist_entry", r.id);
  return r;
}

export async function joinWaitlistPublic(orgId: string, input: WaitlistInput) {
  return withOrg(orgId, async (db) => {
    const loc = await loadLocation(db, input.locationId);
    if (!loc.publicWaitlistEnabled) throw forbidden("Online waitlist is not available", "WAITLIST_DISABLED");
    await requireFeature(db, orgId, "waitlist");
    const r = await createEntry(db, orgId, { ...input, priorityReason: null }, "online", null);
    return r;
  });
}

export async function getPublicWaitlistStatus(token: string) {
  return withSystem(async (db) => {
    const e = await db.maybe<{ id: string; orgId: string; locationId: string; status: string; partySize: number; joinedAt: Date; quotedWaitMin: number | null; name: string }>(
      `SELECT w.id, w.org_id, w.location_id, w.status, w.party_size, w.joined_at, w.quoted_wait_min, w.name FROM waitlist_entries w JOIN organizations o ON o.id=w.org_id
        WHERE w.public_token_hash=$1 AND o.status IN ('trial','active','past_due')`, [sha256(token)]);
    if (!e) throw notFound("Waitlist entry");
    const loc = await loadLocation(db, e.locationId);
    let estimate: WaitEstimate | null = null;
    if (e.status === "waiting" || e.status === "notified") {
      const ahead = (await db.query<{ partySize: number }>(
        `SELECT party_size FROM waitlist_entries WHERE location_id=$1 AND status IN ('waiting','notified') AND (priority, -extract(epoch from joined_at)) > (SELECT priority, -extract(epoch from joined_at) FROM waitlist_entries WHERE id=$2) ORDER BY priority DESC, joined_at`,
        [e.locationId, e.id])).map((r) => r.partySize);
      estimate = await estimateWait(db, loc, e.partySize, ahead);
    }
    return { name: e.name, status: e.status, partySize: e.partySize, joinedAt: e.joinedAt, restaurant: loc.name, estimatedWaitMin: estimate?.minutes ?? null, isEstimate: true,
      disclaimer: "Waiting times are estimates based on current table availability and are not guaranteed." };
  });
}

export async function leaveWaitlistPublic(token: string) {
  return withSystem(async (db) => {
    const r = await db.maybe<{ id: string; orgId: string; locationId: string }>(
      `UPDATE waitlist_entries SET status='cancelled', closed_at=now() WHERE public_token_hash=$1 AND status IN ('waiting','notified') RETURNING id, org_id, location_id`, [sha256(token)]);
    if (!r) throw notFound("Waitlist entry");
    await notifyChange(db, r.orgId, r.locationId, "waitlist");
    return { ok: true };
  });
}

export interface WaitlistEntryRow {
  id: string; locationId: string; customerId: string | null; name: string; phone: string | null; email: string | null; partySize: number; status: string; priority: number;
  priorityReason: string | null; seatingPreference: string | null; notes: string | null; source: string; quotedWaitMin: number | null; joinedAt: Date; notifiedAt: Date | null;
  customerVip: boolean | null; allergies: string[] | null; estimatedWaitMin: number | null; waitedMin: number; position: number;
}

export async function listWaitlist(db: Db, ctx: Ctx, locationId: string, opts: { includeClosed?: boolean } = {}) {
  assertLocationAccess(ctx, locationId);
  const loc = await loadLocation(db, locationId);
  const active = await db.query<Record<string, any>>( // eslint-disable-line @typescript-eslint/no-explicit-any
    `SELECT w.*, c.vip AS customer_vip, c.allergies FROM waitlist_entries w LEFT JOIN customers c ON c.id=w.customer_id
      WHERE w.org_id=$1 AND w.location_id=$2 AND w.status IN ('waiting','notified') ORDER BY w.priority DESC, w.joined_at`, [ctx.orgId, locationId]);
  const now = Date.now();
  const entries: WaitlistEntryRow[] = [];
  const ahead: number[] = [];
  const { tables, combos } = await loadTables(db, locationId);
  const busy = await loadBusy(db, locationId, new Date(now - 3600_000), new Date(now + 8 * 3600_000));
  for (const t of tables) if (t.status === "cleaning") busy.push({ tableId: t.id, start: now, end: now + 10 * 60_000 });
  for (const e of active) {
    const est = simulateWait({ now, tables, combos, busy, durationMin: (p) => durationFor(loc.durationRules, p), bufferMin: loc.bufferMin, ahead: [...ahead], party: e.partySize });
    entries.push({ ...(e as unknown as WaitlistEntryRow), estimatedWaitMin: est, waitedMin: Math.round((now - e.joinedAt.getTime()) / 60_000), position: ahead.length + 1 });
    ahead.push(e.partySize);
  }
  const closed = opts.includeClosed
    ? await db.query(`SELECT * FROM waitlist_entries WHERE org_id=$1 AND location_id=$2 AND status IN ('seated','removed','cancelled') AND closed_at > now() - interval '24 hours' ORDER BY closed_at DESC LIMIT 50`, [ctx.orgId, locationId])
    : [];
  const stats = await waitlistStats(db, ctx.orgId, locationId, 30);
  return { entries, closed, stats, disclaimer: "Estimated wait times are not guaranteed." };
}

export async function waitlistStats(db: Db, orgId: string, locationId: string | null, days: number) {
  return db.one<{ total: number; seated: number; abandoned: number; avgWaitMin: number | null; conversionPct: number | null }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status='seated')::int AS seated,
            count(*) FILTER (WHERE status IN ('removed','cancelled'))::int AS abandoned,
            round(avg(extract(epoch FROM (seated_at - joined_at))/60) FILTER (WHERE status='seated'))::int AS avg_wait_min,
            CASE WHEN count(*) FILTER (WHERE status <> 'waiting' AND status <> 'notified') > 0
                 THEN round(100.0 * count(*) FILTER (WHERE status='seated') / count(*) FILTER (WHERE status NOT IN ('waiting','notified')), 1) END AS conversion_pct
       FROM waitlist_entries WHERE org_id=$1 AND ($2::uuid IS NULL OR location_id=$2) AND joined_at > now() - make_interval(days => $3)`, [orgId, locationId, days]);
}

export const waitlistActionSchema = z.object({
  action: z.enum(["notify", "seat", "remove", "cancel", "link_customer", "update"]),
  tableIds: z.array(z.string().uuid()).max(10).optional(),
  customerId: z.string().uuid().optional(),
  partySize: z.number().int().min(1).max(100).optional(),
  notes: z.string().trim().max(500).optional().nullable(),
  priorityReason: z.enum(["accessibility", "reservation_commitment", "vip", "other"]).optional().nullable(),
});

export async function waitlistAction(ctx: Ctx, id: string, input: z.infer<typeof waitlistActionSchema>) {
  return withOrg(ctx.orgId, async (db) => {
    const e = await db.maybe<{ id: string; locationId: string; status: string; partySize: number; name: string; phone: string | null; email: string | null; customerId: string | null; notes: string | null }>(
      `SELECT * FROM waitlist_entries WHERE id=$1 AND org_id=$2 FOR UPDATE`, [id, ctx.orgId]);
    if (!e) throw notFound("Waitlist entry");
    assertLocationAccess(ctx, e.locationId);
    const active = e.status === "waiting" || e.status === "notified";
    if (!active) throw conflict(`This entry is already ${e.status}`, "WAITLIST_NOT_ACTIVE");
    switch (input.action) {
      case "notify": {
        await db.exec(`UPDATE waitlist_entries SET status='notified', notified_at=now() WHERE id=$1`, [id]);
        await dispatchEvent(db, { type: "waitlist_ready", orgId: ctx.orgId, locationId: e.locationId, waitlistEntryId: id, version: Date.now() });
        break;
      }
      case "remove":
      case "cancel":
        await db.exec(`UPDATE waitlist_entries SET status=$2, closed_at=now() WHERE id=$1`, [id, input.action === "remove" ? "removed" : "cancelled"]);
        break;
      case "link_customer": {
        if (!input.customerId) throw badRequest("customerId required");
        const c = await db.maybe(`SELECT 1 FROM customers WHERE id=$1 AND org_id=$2 AND merged_into IS NULL`, [input.customerId, ctx.orgId]);
        if (!c) throw notFound("Customer");
        await db.exec(`UPDATE waitlist_entries SET customer_id=$2 WHERE id=$1`, [id, input.customerId]);
        break;
      }
      case "update":
        await db.exec(`UPDATE waitlist_entries SET party_size=COALESCE($2,party_size), notes=COALESCE($3,notes), priority_reason=COALESCE($4,priority_reason) WHERE id=$1`, [id, input.partySize ?? null, input.notes ?? null, input.priorityReason ?? null]);
        break;
      case "seat":
        break; // handled after the transaction callback (needs its own booking transaction logic)
    }
    if (input.action === "seat") {
      // seatWalkIn runs inside this same transaction would require nesting; instead we mark intent and let the caller run it
      return { seat: true as const, entry: e };
    }
    await audit(db, ctx, `waitlist.${input.action}`, "waitlist_entry", id);
    await notifyChange(db, ctx.orgId, e.locationId, "waitlist");
    return { seat: false as const, ok: true };
  }).then(async (r) => {
    if (!("seat" in r) || !r.seat) return { ok: true };
    const e = r.entry;
    const res = await seatWalkIn(ctx, {
      locationId: e.locationId, partySize: e.partySize, guestName: e.name, guestPhone: e.phone, guestEmail: e.email, tableIds: input.tableIds, notes: e.notes ?? undefined, waitlistEntryId: e.id,
    });
    return { ok: true, reservationId: res.id, tableIds: res.tableIds };
  });
}
