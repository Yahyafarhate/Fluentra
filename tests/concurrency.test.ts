import { describe, expect, it } from "vitest";
import { withOrg, withSystem } from "@/lib/db";
import { createTenant, booking, futureDate } from "./helpers";
import { createReservation, updateReservation } from "@/server/reservations/service";

describe("concurrent booking protection", () => {
  it("lets exactly one of 12 simultaneous bookings take the last table", async () => {
    const t = await createTenant({ tables: [{ name: "Last", capacity: 2 }] });
    const date = futureDate(6);
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
      createReservation(t.owner, booking(t, { date, time: "20:00", guestName: `Racer ${i}`, guestPhone: `+21266100${String(i).padStart(4, "0")}` }))));
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(11);
    for (const f of failed) expect(["NO_AVAILABILITY", "TABLE_CONFLICT"]).toContain((f.reason as { code: string }).code);
    const rows = await withOrg(t.orgId, (db) => db.query(`SELECT 1 FROM reservations WHERE location_id=$1 AND service_date=$2`, [t.locationId, date]));
    expect(rows).toHaveLength(1);
  });

  it("books exactly N reservations when N tables exist, with overlapping times", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 2 }, { name: "B", capacity: 2 }, { name: "C", capacity: 2 }] });
    const date = futureDate(7);
    const times = ["19:00", "19:15", "19:30", "19:00", "19:15", "19:30", "19:45", "19:00", "20:00", "19:30"];
    const results = await Promise.allSettled(times.map((time, i) =>
      createReservation(t.owner, booking(t, { date, time, guestName: `P${i}`, guestPhone: `+21266200${String(i).padStart(4, "0")}` }))));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    // invariant: no table has overlapping assignments
    const overlaps = await withOrg(t.orgId, (db) => db.query(
      `SELECT 1 FROM reservation_tables a JOIN reservation_tables b ON a.table_id=b.table_id AND a.reservation_id<>b.reservation_id AND a.during && b.during`));
    expect(overlaps).toHaveLength(0);
  });

  it("serializes a reschedule racing a new booking for the same slot", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 2 }] });
    const date = futureDate(8);
    const a = await createReservation(t.owner, booking(t, { date, time: "18:00" }));
    const [r1, r2] = await Promise.allSettled([
      updateReservation(t.owner, a.id, { time: "21:00" }),
      createReservation(t.owner, booking(t, { date, time: "21:00", guestPhone: "+212655500001" })),
    ]);
    expect([r1.status, r2.status].filter((s) => s === "fulfilled")).toHaveLength(1);
  });

  it("the database itself rejects overlapping assignments even if application checks are bypassed", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 2 }] });
    const date = futureDate(9);
    const a = await createReservation(t.owner, booking(t, { date, time: "19:00" }));
    // forge a second reservation row, then try to attach the same table at an overlapping time directly in SQL
    await expect(withSystem(async (db) => {
      const r = await db.one<{ id: string }>(
        `INSERT INTO reservations (org_id, location_id, code, guest_name, party_size, service_date, start_at, end_at, status, source)
         SELECT org_id, location_id, 'FORGED1', 'Forged', 2, service_date, start_at + interval '10 minutes', end_at, 'confirmed', 'staff' FROM reservations WHERE id=$1 RETURNING id`, [a.id]);
      await db.exec(
        `INSERT INTO reservation_tables (reservation_id, table_id, org_id, location_id, during)
         SELECT $1, table_id, org_id, location_id, tstzrange(lower(during) + interval '10 minutes', upper(during) + interval '10 minutes') FROM reservation_tables WHERE reservation_id=$2`, [r.id, a.id]);
    })).rejects.toMatchObject({ code: "23P01" });
  });
});
