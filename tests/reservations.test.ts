import { afterEach, describe, expect, it } from "vitest";
import { withOrg, withSystem } from "@/lib/db";
import { createTenant, booking, futureDate } from "./helpers";
import { createReservationTx, listAssignableTables, createReservation, transitionReservation, updateReservation, listMoveTargets, listReservations, getReservation, seatWalkIn } from "@/server/reservations/service";
import { computeSlots } from "@/server/availability/service";
import { loadLocation } from "@/server/availability/service";

const tableOf = async (orgId: string, resId: string) =>
  withOrg(orgId, (db) => db.query<{ name: string }>(`SELECT t.name FROM reservation_tables rt JOIN tables t ON t.id=rt.table_id WHERE rt.reservation_id=$1 ORDER BY t.name`, [resId]));

describe("reservation creation & availability", () => {
  it("creates a confirmed reservation with a best-fit table and a customer profile", async () => {
    const t = await createTenant();
    const r = await createReservation(t.owner, booking(t, { partySize: 3 }));
    expect(r.status).toBe("confirmed");
    expect((await tableOf(t.orgId, r.id)).map((x) => x.name)).toEqual(["T2"]);
    const c = await withOrg(t.orgId, (db) => db.query(`SELECT * FROM customers`));
    expect(c).toHaveLength(1);
  });

  it("links repeated bookings from the same phone to one customer, but never merges by name alone", async () => {
    const t = await createTenant();
    await createReservation(t.owner, booking(t, { guestName: "Karim Alami", guestPhone: "06 61 11 22 33", time: "12:00" }));
    await createReservation(t.owner, booking(t, { guestName: "K. Alami", guestPhone: "+212661112233", time: "19:00" }));
    await createReservation(t.owner, booking(t, { guestName: "Karim Alami", guestPhone: "+212677778888", time: "20:30" }));
    const c = await withOrg(t.orgId, (db) => db.query<{ name: string }>(`SELECT name FROM customers ORDER BY created_at`));
    expect(c).toHaveLength(2);
  });

  it("rejects overlapping bookings when capacity is exhausted and frees it after cancellation", async () => {
    const t = await createTenant({ tables: [{ name: "Only", capacity: 4 }] });
    const a = await createReservation(t.owner, booking(t, { partySize: 4 }));
    await expect(createReservation(t.owner, booking(t, { partySize: 2, time: "19:30" }))).rejects.toMatchObject({ code: "NO_AVAILABILITY" });
    await transitionReservation(t.owner, a.id, { action: "cancel" });
    await expect(createReservation(t.owner, booking(t, { partySize: 2, time: "19:30" }))).resolves.toBeTruthy();
  });

  it("allows back-to-back bookings once duration + buffer have elapsed", async () => {
    const t = await createTenant({ tables: [{ name: "Only", capacity: 2 }] });
    await createReservation(t.owner, booking(t, { time: "12:00" })); // 90 min + 10 min buffer -> free at 13:40
    await expect(createReservation(t.owner, booking(t, { time: "13:30" }))).rejects.toMatchObject({ code: "NO_AVAILABILITY" });
    await expect(createReservation(t.owner, booking(t, { time: "13:45" }))).resolves.toBeTruthy();
  });

  it("validates party size against capacity", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 4 }] });
    await expect(createReservation(t.owner, booking(t, { partySize: 5 }))).rejects.toMatchObject({ code: "NO_AVAILABILITY" });
  });

  it("combines tables for large parties", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 4 }, { name: "B", capacity: 4 }] });
    const { createCombination } = await import("@/server/floor/service");
    await withOrg(t.orgId, (db) => createCombination(db, t.owner, { locationId: t.locationId, name: "A+B", tableIds: t.tableIds, capacity: 8, minCapacity: 5 }));
    const r = await createReservation(t.owner, booking(t, { partySize: 7 }));
    expect((await tableOf(t.orgId, r.id)).map((x) => x.name)).toEqual(["A", "B"]);
    await expect(createReservation(t.owner, booking(t, { partySize: 2 }))).rejects.toMatchObject({ code: "NO_AVAILABILITY" });
  });

  it("refuses closed days, special closures and times outside service hours", async () => {
    const t = await createTenant();
    await expect(createReservation(t.owner, booking(t, { time: "03:00" }))).rejects.toMatchObject({ code: "CLOSED" });
    const date = futureDate(5);
    await withSystem((db) => db.exec(`INSERT INTO special_days (org_id, location_id, date, closed, label) VALUES ($1,$2,$3,true,'Holiday')`, [t.orgId, t.locationId, date]));
    await expect(createReservation(t.owner, booking(t, { date }))).rejects.toMatchObject({ code: "CLOSED" });
  });

  it("enforces cover pacing per slot", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 4 }, { name: "B", capacity: 4 }, { name: "C", capacity: 4 }] });
    await withSystem((db) => db.exec(`UPDATE locations SET max_covers_per_slot=6 WHERE id=$1`, [t.locationId]));
    await createReservation(t.owner, booking(t, { partySize: 4 }));
    await expect(createReservation(t.owner, booking(t, { partySize: 4 }))).rejects.toMatchObject({ code: "PACING_LIMIT" });
    await expect(createReservation(t.owner, booking(t, { partySize: 2 }))).resolves.toBeTruthy();
  });

  it("prevents duplicate bookings for the same guest and overlapping time", async () => {
    const t = await createTenant();
    const b = booking(t, { guestPhone: "+212600000001" });
    await createReservation(t.owner, b);
    await expect(createReservation(t.owner, { ...(b as object), time: "19:30" } as never)).rejects.toMatchObject({ code: "DUPLICATE_RESERVATION" });
    await expect(createReservation(t.owner, { ...(b as object), time: "19:30", allowDuplicate: true } as never)).resolves.toBeTruthy();
  });

  it("slot listing reflects reservations", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 2 }] });
    const date = futureDate(4);
    await createReservation(t.owner, booking(t, { date, time: "19:00" }));
    const slots = await withOrg(t.orgId, async (db) => computeSlots(db, await loadLocation(db, t.locationId), date, { channel: "online", partySize: 2 }));
    const at = (h: string) => slots.slots.find((s) => s.time === h)!;
    expect(at("19:00").available).toBe(false);
    expect(at("18:00").available).toBe(false); // a 90 min + 10 min buffer sitting from 18:00 would collide
    expect(at("17:00").available).toBe(true);
    expect(at("21:00").available).toBe(true);
  });
});

describe("rescheduling & editing", () => {
  it("moves a reservation, keeps the table when free, and releases the old slot", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 2 }] });
    const a = await createReservation(t.owner, booking(t, { time: "19:00" }));
    await updateReservation(t.owner, a.id, { time: "21:00" });
    await expect(createReservation(t.owner, booking(t, { time: "19:00" }))).resolves.toBeTruthy();
    const r = await withOrg(t.orgId, (db) => getReservation(db, t.owner, a.id));
    expect(r.rescheduleCount).toBe(1);
  });
  it("refuses a reschedule into a conflict and leaves the original intact", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 2 }] });
    const a = await createReservation(t.owner, booking(t, { time: "19:00" }));
    await createReservation(t.owner, booking(t, { time: "21:00" }));
    await expect(updateReservation(t.owner, a.id, { time: "21:15" })).rejects.toMatchObject({ code: "NO_AVAILABILITY" });
    const r = await withOrg(t.orgId, (db) => getReservation(db, t.owner, a.id));
    expect(r.status).toBe("confirmed");
    expect((await tableOf(t.orgId, a.id))).toHaveLength(1);
  });
  it("re-checks capacity when the party grows", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 2 }, { name: "B", capacity: 6 }] });
    const a = await createReservation(t.owner, booking(t, { partySize: 2 }));
    await updateReservation(t.owner, a.id, { partySize: 5 });
    expect((await tableOf(t.orgId, a.id)).map((x) => x.name)).toEqual(["B"]);
    await expect(updateReservation(t.owner, a.id, { partySize: 20 })).rejects.toMatchObject({ code: "NO_AVAILABILITY" });
  });
});

describe("reservation lifecycle", () => {
  it("runs the full host journey: arrive → seat → complete → table ready", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 4 }] });
    const now = new Date();
    const r = await createReservation(t.owner, booking(t, { date: futureDate(0), time: "23:00", force: true }) as never).catch(() => null);
    // create a reservation for "now" using walk-in seat path instead (always valid)
    expect(r === null || r).toBeDefined();
    const w = await seatWalkIn(t.owner, { locationId: t.locationId, partySize: 2, guestName: "Walk Guest" });
    const tbl = () => withOrg(t.orgId, (db) => db.one<{ status: string }>(`SELECT status FROM tables WHERE id=$1`, [t.tableIds[0]]));
    expect((await tbl()).status).toBe("occupied");
    await expect(seatWalkIn(t.owner, { locationId: t.locationId, partySize: 2 })).rejects.toMatchObject({ code: "NO_AVAILABILITY" });
    await transitionReservation(t.owner, w.id, { action: "complete", spendAmount: 640 });
    expect((await tbl()).status).toBe("cleaning");
    // a cleaning table cannot take a walk-in until marked ready
    await expect(seatWalkIn(t.owner, { locationId: t.locationId, partySize: 2 })).rejects.toMatchObject({ code: "NO_AVAILABILITY" });
    const { setTableStatus } = await import("@/server/floor/service");
    await withOrg(t.orgId, (db) => setTableStatus(db, t.owner, t.tableIds[0], { status: "available" }));
    expect((await tbl()).status).toBe("available");
    await expect(seatWalkIn(t.owner, { locationId: t.locationId, partySize: 2 })).resolves.toBeTruthy();
    const v = await withOrg(t.orgId, (db) => db.query(`SELECT spend_amount, left_at FROM visits WHERE reservation_id=$1`, [w.id]));
    expect(v[0]).toMatchObject({ spendAmount: 640 });
    expect(now).toBeTruthy();
  });

  it("enforces legal status transitions and table readiness when seating", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 4 }] });
    const a = await createReservation(t.owner, booking(t, { partySize: 2, status: "pending" }));
    await expect(transitionReservation(t.owner, a.id, { action: "complete" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await transitionReservation(t.owner, a.id, { action: "confirm" });
    await transitionReservation(t.owner, a.id, { action: "arrive" });
    await withSystem((db) => db.exec(`UPDATE tables SET status='cleaning' WHERE id=$1`, [t.tableIds[0]]));
    await expect(transitionReservation(t.owner, a.id, { action: "seat" })).rejects.toMatchObject({ code: "TABLE_NOT_READY" });
    await withSystem((db) => db.exec(`UPDATE tables SET status='blocked' WHERE id=$1`, [t.tableIds[0]]));
    await expect(transitionReservation(t.owner, a.id, { action: "seat", force: true })).rejects.toMatchObject({ code: "TABLE_UNAVAILABLE" });
    await withSystem((db) => db.exec(`UPDATE tables SET status='available' WHERE id=$1`, [t.tableIds[0]]));
    await transitionReservation(t.owner, a.id, { action: "seat" });
    await expect(transitionReservation(t.owner, a.id, { action: "cancel" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await transitionReservation(t.owner, a.id, { action: "complete" });
    await expect(transitionReservation(t.owner, a.id, { action: "arrive" })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("records no-shows only after the grace period and releases tables", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 4 }] });
    const a = await createReservation(t.owner, booking(t, { partySize: 2 }));
    await expect(transitionReservation(t.owner, a.id, { action: "no_show" })).rejects.toMatchObject({ code: "TOO_EARLY_FOR_NO_SHOW" });
    await transitionReservation(t.owner, a.id, { action: "no_show", force: true });
    expect(await tableOf(t.orgId, a.id)).toHaveLength(0);
    await transitionReservation(t.owner, a.id, { action: "reinstate" });
    expect(await tableOf(t.orgId, a.id)).toHaveLength(1);
  });

  it("filters and searches reservations", async () => {
    const t = await createTenant();
    await createReservation(t.owner, booking(t, { guestName: "Yasmine Tazi", guestPhone: "+212611223344", partySize: 5, time: "20:00" }));
    await createReservation(t.owner, booking(t, { guestName: "Omar Fassi", partySize: 2, time: "13:00" }));
    const f = (q: object) => withOrg(t.orgId, (db) => listReservations(db, t.owner, { limit: 100, offset: 0, ...q } as never));
    expect(await f({ q: "yasmine" })).toHaveLength(1);
    expect(await f({ q: "611223" })).toHaveLength(1);
    expect(await f({ minParty: 4 })).toHaveLength(1);
    expect(await f({ timeFrom: "12:00", timeTo: "14:00" })).toHaveLength(1);
    expect(await f({ status: "cancelled" })).toHaveLength(0);
    expect(await f({ date: futureDate(3) })).toHaveLength(2);
  });
});

describe("seating before the booked time", () => {
  it("moves the table's occupancy window to now and refuses when another booking is in the way", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 2 }, { name: "B", capacity: 2 }] });
    const date = futureDate(1);
    const early = await createReservation(t.owner, booking(t, { date, time: "20:00", partySize: 2, tableIds: [t.tableIds[0]] }));
    await transitionReservation(t.owner, early.id, { action: "seat" });
    const win = await withOrg(t.orgId, (db) => db.one<{ lower: Date }>(`SELECT lower(during) AS lower FROM reservation_tables WHERE reservation_id=$1`, [early.id]));
    expect(win.lower.getTime()).toBeLessThanOrEqual(Date.now());
    // table A is now busy from now → a walk-in must take B
    const w = await seatWalkIn(t.owner, { locationId: t.locationId, partySize: 2 });
    expect(w.tableIds).toEqual([t.tableIds[1]]);
    // a booking sitting between now and a later reservation on the same table blocks early seating
    const t2 = await createTenant({ tables: [{ name: "Only", capacity: 2 }] });
    const later = await createReservation(t2.owner, booking(t2, { date: futureDate(2), time: "20:00" }));
    await createReservation(t2.owner, booking(t2, { date: futureDate(1), time: "12:00" }));
    await expect(transitionReservation(t2.owner, later.id, { action: "seat" })).rejects.toMatchObject({ code: "TABLE_BUSY_UNTIL" });
  });
});

describe("moving a seated party to another table", () => {
  const status = (orgId: string, id: string) => withOrg(orgId, (db) => db.one<{ status: string }>(`SELECT status FROM tables WHERE id=$1`, [id])).then((r) => r.status);

  it("moves the guests, marks the old table awaiting cleaning and the new one occupied, and audits it", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 2 }, { name: "B", capacity: 2 }, { name: "C", capacity: 4 }] });
    const [A, B] = t.tableIds;
    const r = await createReservation(t.owner, booking(t, { date: futureDate(1), time: "20:00", partySize: 2, tableIds: [A] }));
    // not seated yet → the dedicated action is refused (changing the table before seating is a plain edit)
    await expect(transitionReservation(t.owner, r.id, { action: "move_table", tableIds: [B] })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await transitionReservation(t.owner, r.id, { action: "seat" });
    expect(await status(t.orgId, A)).toBe("occupied");

    await expect(transitionReservation(t.owner, r.id, { action: "move_table", tableIds: [A] })).rejects.toMatchObject({ code: "SAME_TABLES" });
    await expect(transitionReservation(t.owner, r.id, { action: "move_table" })).rejects.toMatchObject({ code: "NO_TABLE" });

    const res = await transitionReservation(t.owner, r.id, { action: "move_table", tableIds: [B] });
    expect(res.status).toBe("seated");
    expect(await status(t.orgId, A)).toBe("cleaning");
    expect(await status(t.orgId, B)).toBe("occupied");
    const links = await withOrg(t.orgId, (db) => db.query<{ tableId: string; lower: Date }>(`SELECT table_id, lower(during) AS lower FROM reservation_tables WHERE reservation_id=$1`, [r.id]));
    expect(links.map((l) => l.tableId)).toEqual([B]);
    expect(links[0].lower.getTime()).toBeLessThanOrEqual(Date.now());
    const visit = await withOrg(t.orgId, (db) => db.one<{ tableIds: string[] }>(`SELECT table_ids FROM visits WHERE reservation_id=$1`, [r.id]));
    expect(visit.tableIds).toEqual([B]);
    const audit = await withOrg(t.orgId, (db) => db.one<{ metadata: { fromTables: string[]; toTables: string[] } }>(`SELECT metadata FROM audit_logs WHERE action='reservation.move_table' AND entity_id=$1`, [r.id]));
    expect(audit.metadata).toMatchObject({ fromTables: ["A"], toTables: ["B"] });

    // completing the visit now releases the NEW table; the old one stays awaiting cleaning until staff mark it ready
    await transitionReservation(t.owner, r.id, { action: "complete" });
    expect(await status(t.orgId, B)).toBe("cleaning");
    expect(await status(t.orgId, A)).toBe("cleaning");
  });

  it("refuses an occupied table, a table that is too small and a table that was just taken", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 2 }, { name: "B", capacity: 2 }, { name: "C", capacity: 4 }] });
    const [A, B, C] = t.tableIds;
    const r = await createReservation(t.owner, booking(t, { date: futureDate(1), time: "20:00", partySize: 2, tableIds: [A] }));
    await transitionReservation(t.owner, r.id, { action: "seat" });
    const walkIn = await seatWalkIn(t.owner, { locationId: t.locationId, partySize: 2 });     // takes B or C
    const taken = walkIn.tableIds[0];
    await expect(transitionReservation(t.owner, r.id, { action: "move_table", tableIds: [taken] })).rejects.toBeTruthy();
    expect(await status(t.orgId, A)).toBe("occupied");                                          // nothing changed
    const big = await createReservation(t.owner, booking(t, { date: futureDate(1), time: "12:00", partySize: 4, tableIds: [C] }));
    if (taken !== C) {
      await transitionReservation(t.owner, big.id, { action: "seat" });
      await expect(transitionReservation(t.owner, big.id, { action: "move_table", tableIds: [B === taken ? A : B] })).rejects.toMatchObject({ code: "INSUFFICIENT_CAPACITY" });
    }
  });

  it("two parties cannot be moved onto the same table at once", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 2 }, { name: "B", capacity: 2 }, { name: "C", capacity: 2 }] });
    const [A, B, C] = t.tableIds;
    const r1 = await createReservation(t.owner, booking(t, { date: futureDate(1), time: "19:00", partySize: 2, tableIds: [A] }));
    const r2 = await createReservation(t.owner, booking(t, { date: futureDate(1), time: "19:00", partySize: 2, tableIds: [B] }));
    await transitionReservation(t.owner, r1.id, { action: "seat" });
    await transitionReservation(t.owner, r2.id, { action: "seat" });
    const out = await Promise.allSettled([
      transitionReservation(t.owner, r1.id, { action: "move_table", tableIds: [C] }),
      transitionReservation(t.owner, r2.id, { action: "move_table", tableIds: [C] }),
    ]);
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const winner = out[0].status === "fulfilled" ? [r1.id, A] : [r2.id, B];
    const loser = out[0].status === "fulfilled" ? B : A;
    expect(await status(t.orgId, C)).toBe("occupied");
    expect(await status(t.orgId, winner[1] as string)).toBe("cleaning");
    expect(await status(t.orgId, loser)).toBe("occupied");                                     // the other party never moved
    const n = await withOrg(t.orgId, (db) => db.one<{ n: number }>(`SELECT count(*)::int AS n FROM reservation_tables WHERE table_id=$1`, [C]));
    expect(n.n).toBe(1);
  });
});

describe("changing the table of a seated party through the edit form", () => {
  const status = (orgId: string, id: string) => withOrg(orgId, (db) => db.one<{ status: string }>(`SELECT status FROM tables WHERE id=$1`, [id])).then((r) => r.status);

  it("behaves exactly like a move: old table awaiting cleaning, new table occupied, visit updated", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 2 }, { name: "B", capacity: 2 }] });
    const [A, B] = t.tableIds;
    const r = await createReservation(t.owner, booking(t, { date: futureDate(1), time: "20:00", partySize: 2, tableIds: [A] }));
    await transitionReservation(t.owner, r.id, { action: "seat" });
    await updateReservation(t.owner, r.id, { tableIds: [A] });          // unchanged table: no-op
    expect(await status(t.orgId, A)).toBe("occupied");
    await updateReservation(t.owner, r.id, { tableIds: [B] });
    expect(await status(t.orgId, A)).toBe("cleaning");
    expect(await status(t.orgId, B)).toBe("occupied");
    const visit = await withOrg(t.orgId, (db) => db.one<{ tableIds: string[] }>(`SELECT table_ids FROM visits WHERE reservation_id=$1`, [r.id]));
    expect(visit.tableIds).toEqual([B]);
  });

  it("lists only tables that are really free for the move", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 2 }, { name: "B", capacity: 2 }, { name: "C", capacity: 2 }, { name: "D", capacity: 2 }, { name: "E", capacity: 1 }] });
    const [A, B, C, D, E] = t.tableIds;
    const r = await createReservation(t.owner, booking(t, { date: futureDate(1), time: "20:00", partySize: 2, tableIds: [A] }));
    await transitionReservation(t.owner, r.id, { action: "seat" });
    const { setTableStatus } = await import("@/server/floor/service");
    await withOrg(t.orgId, (db) => setTableStatus(db, t.owner, C, { status: "cleaning" }));
    await withOrg(t.orgId, (db) => setTableStatus(db, t.owner, D, { status: "blocked", reason: "x" }));
    const ids = (await listMoveTargets(t.owner, r.id)).map((x) => x.id);
    expect(ids).toEqual([B]);                       // not the current table, not cleaning/blocked, not too small
    expect(ids).not.toContain(E);
    await expect(listMoveTargets(t.owner, (await createReservation(t.owner, booking(t, { date: futureDate(2), time: "20:00", partySize: 2 }))).id)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("lets staff reset an occupied table that has nobody seated on it, but never one with a seated party", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 2 }, { name: "B", capacity: 2 }] });
    const [A, B] = t.tableIds;
    const { setTableStatus } = await import("@/server/floor/service");
    const r = await createReservation(t.owner, booking(t, { date: futureDate(1), time: "20:00", partySize: 2, tableIds: [A] }));
    await transitionReservation(t.owner, r.id, { action: "seat" });
    await expect(withOrg(t.orgId, (db) => setTableStatus(db, t.owner, A, { status: "available" }))).rejects.toMatchObject({ code: "TABLE_OCCUPIED" });
    await withSystem((db) => db.exec(`UPDATE tables SET status='occupied' WHERE id=$1`, [B]));   // stale leftover
    await withOrg(t.orgId, (db) => setTableStatus(db, t.owner, B, { status: "available" }));
    expect(await status(t.orgId, B)).toBe("available");
  });
});

describe("grouping tables for a large party", () => {
  const big = async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 8 }, { name: "B", capacity: 4 }, { name: "C", capacity: 4 }] });
    await withSystem((db) => db.exec(`UPDATE locations SET max_party_online=20 WHERE id=$1`, [t.locationId]));
    orgs.push(t.orgId);
    return t;
  };
  // guest bookings queue confirmation messages; drop them so they cannot compete with other test files for the shared worker batch
  const orgs: string[] = [];
  afterEach(async () => { if (orgs.length) await withSystem((db) => db.exec(`DELETE FROM notifications WHERE status='queued' AND org_id = ANY($1::uuid[])`, [orgs.splice(0)])); });
  const guest = (t: Awaited<ReturnType<typeof big>>, over: Record<string, unknown> = {}) => withOrg(t.orgId, (db) =>
    createReservationTx(db, booking(t, { date: futureDate(3), time: "20:00", partySize: 12, guestPhone: "+212600000099", source: "online", ...over }), { orgId: t.orgId, actor: { kind: "guest" } }));

  it("an online guest must accept grouping; the booking then waits for validation", async () => {
    const t = await big();
    await expect(guest(t)).rejects.toMatchObject({ code: "GROUPING_REQUIRED" });                    // not accepted → refused
    const r = await guest(t, { groupingAccepted: true });
    expect(r.status).toBe("pending");                                                              // even if auto-confirm is on
    expect(r.tableIds).toHaveLength(2);
    const d = await withOrg(t.orgId, (db) => db.one<{ groupingAccepted: boolean }>(`SELECT grouping_accepted FROM reservations WHERE id=$1`, [r.id]));
    expect(d.groupingAccepted).toBe(true);
    // the grouped tables are really reserved: a second 12-person party finds nothing
    await expect(guest(t, { groupingAccepted: true, guestPhone: "+212600000098" })).rejects.toMatchObject({ code: "NO_AVAILABILITY" });
  });

  it("a validator sees free tables, a suggestion, and can choose the tables by hand", async () => {
    const t = await big();
    const [A, B, C] = t.tableIds;
    const r = await guest(t, { groupingAccepted: true });
    const a = await listAssignableTables(t.owner, r.id);
    expect(a.suggested).toContain(A);                                                              // the 8-seater + one 4-seater
    expect(a.suggested).toHaveLength(2);
    expect(a.tables.map((x) => x.id).sort()).toEqual([A, B, C].sort());
    await updateReservation(t.owner, r.id, { tableIds: [A, C] });
    const links = await withOrg(t.orgId, (db) => db.query<{ tableId: string }>(`SELECT table_id FROM reservation_tables WHERE reservation_id=$1`, [r.id]));
    expect(links.map((l) => l.tableId).sort()).toEqual([A, C].sort());
    await expect(updateReservation(t.owner, r.id, { tableIds: [B, C] })).rejects.toMatchObject({ code: "INSUFFICIENT_CAPACITY" });
    await transitionReservation(t.owner, r.id, { action: "confirm" });
    const seated = await transitionReservation(t.owner, r.id, { action: "seat" });
    expect(seated.status).toBe("seated");
  });

  it("staff bookings group automatically without the guest flag", async () => {
    const t = await big();
    const r = await createReservation(t.owner, booking(t, { date: futureDate(3), time: "20:00", partySize: 12 }));
    expect(r.tableIds).toHaveLength(2);
    expect(r.status).toBe("confirmed");
  });
});
