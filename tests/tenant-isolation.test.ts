import { describe, expect, it } from "vitest";
import { getPool, withOrg, withSystem } from "@/lib/db";
import { addMember, booking, createTenant } from "./helpers";
import { createReservation, getReservation, transitionReservation, updateReservation, listReservations } from "@/server/reservations/service";
import { getCustomerProfile, queryCustomers, mergeCustomers, exportCustomerData } from "@/server/customers/service";
import { getFloorState, updateTable, deleteTable, setTableStatus } from "@/server/floor/service";
import { getAnalytics } from "@/server/analytics/service";
import { getDashboard } from "@/server/dashboard/service";
import { futureDate } from "./helpers";

describe("tenant isolation (database + service layer)", () => {
  it("RLS hides all tenant rows from an unscoped connection", async () => {
    const t = await createTenant();
    await createReservation(t.owner, booking(t));
    const r = await getPool().query("SELECT count(*)::int AS n FROM reservations");
    expect(r.rows[0].n).toBe(0);
    for (const table of ["customers", "locations", "tables", "floor_items", "notifications", "audit_logs", "organizations", "users", "memberships"]) {
      const x = await getPool().query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(x.rows[0].n, table).toBe(0);
    }
  });

  it("a scoped transaction cannot read or write another organization's rows, even by id", async () => {
    const a = await createTenant(); const b = await createTenant();
    const resB = await createReservation(b.owner, booking(b));
    await expect(withOrg(a.orgId, (db) => db.query(`SELECT * FROM reservations WHERE id=$1`, [resB.id]))).resolves.toHaveLength(0);
    await expect(withOrg(a.orgId, (db) => db.exec(`UPDATE reservations SET guest_name='pwned' WHERE id=$1`, [resB.id]))).resolves.toBe(0);
    await expect(withOrg(a.orgId, (db) => db.exec(`DELETE FROM reservations WHERE id=$1`, [resB.id]))).resolves.toBe(0);
    await expect(withOrg(a.orgId, (db) => db.exec(
      `INSERT INTO customers (org_id, name) VALUES ($1, 'Injected')`, [b.orgId]))).rejects.toThrow(/row-level security/);
  });

  it("composite foreign keys stop cross-tenant references even from the system scope", async () => {
    const a = await createTenant(); const b = await createTenant();
    const cust = await withSystem((db) => db.one<{ id: string }>(`INSERT INTO customers (org_id, name) VALUES ($1,'B guest') RETURNING id`, [b.orgId]));
    await expect(withSystem((db) => db.exec(
      `INSERT INTO reservations (org_id, location_id, customer_id, code, guest_name, party_size, service_date, start_at, end_at) VALUES ($1,$2,$3,'XTENANT','x',2,current_date,now(),now()+interval '1 hour')`,
      [a.orgId, a.locationId, cust.id]))).rejects.toMatchObject({ code: "23503" });
    await expect(withSystem((db) => db.exec(
      `INSERT INTO tables (org_id, location_id, floor_id, name, capacity) VALUES ($1,$2,$3,'X',2)`, [a.orgId, a.locationId, b.floorId]))).rejects.toMatchObject({ code: "23503" });
  });

  it("services reject foreign identifiers (read, update, transition, delete, export, merge)", async () => {
    const a = await createTenant(); const b = await createTenant();
    const resB = await createReservation(b.owner, booking(b));
    const custB = await withOrg(b.orgId, (db) => db.one<{ id: string }>(`SELECT id FROM customers LIMIT 1`));
    const notFound = { code: "NOT_FOUND" };
    await expect(withOrg(a.orgId, (db) => getReservation(db, a.owner, resB.id))).rejects.toMatchObject(notFound);
    await expect(transitionReservation(a.owner, resB.id, { action: "cancel" })).rejects.toMatchObject(notFound);
    await expect(updateReservation(a.owner, resB.id, { guestName: "x" })).rejects.toMatchObject(notFound);
    await expect(withOrg(a.orgId, (db) => getCustomerProfile(db, a.owner, custB.id))).rejects.toMatchObject(notFound);
    await expect(withOrg(a.orgId, (db) => exportCustomerData(db, a.owner, custB.id))).rejects.toMatchObject(notFound);
    await expect(withOrg(a.orgId, (db) => updateTable(db, a.owner, b.tableIds[0], { name: "pwn" }))).rejects.toMatchObject(notFound);
    await expect(withOrg(a.orgId, (db) => deleteTable(db, a.owner, b.tableIds[0]))).rejects.toMatchObject(notFound);
    await expect(withOrg(a.orgId, (db) => setTableStatus(db, a.owner, b.tableIds[0], { status: "blocked" }))).rejects.toMatchObject(notFound);
    const custA = await createReservation(a.owner, booking(a)).then(() => withOrg(a.orgId, (db) => db.one<{ id: string }>(`SELECT id FROM customers LIMIT 1`)));
    await expect(withOrg(a.orgId, (db) => mergeCustomers(db, a.owner, custA.id, custB.id))).rejects.toMatchObject(notFound);
    // cannot create a reservation in someone else's location
    await expect(createReservation(a.owner, booking(b))).rejects.toMatchObject(notFound);
    // cannot book onto another tenant's table
    await expect(createReservation(a.owner, booking(a, { tableIds: [b.tableIds[0]] }))).rejects.toMatchObject({ code: "UNKNOWN_TABLE" });
    await expect(withOrg(a.orgId, (db) => getFloorState(db, a.owner, b.locationId))).rejects.toBeTruthy();
    // the victim's data is untouched
    const still = await withOrg(b.orgId, (db) => getReservation(db, b.owner, resB.id));
    expect(still.status).toBe("confirmed");
  });

  it("lists, dashboards and analytics only contain the caller's data", async () => {
    const a = await createTenant(); const b = await createTenant();
    const date = futureDate(2);
    await createReservation(a.owner, booking(a, { date, guestName: "Alice A" }));
    await createReservation(b.owner, booking(b, { date, guestName: "Bob B" }));
    const listA = await withOrg(a.orgId, (db) => listReservations(db, a.owner, { date, limit: 100, offset: 0 } as never));
    expect(listA.map((r) => r.guestName)).toEqual(["Alice A"]);
    const cust = await withOrg(a.orgId, (db) => queryCustomers(db, a.orgId, {}));
    expect(cust.rows.map((c) => c.name)).toEqual(["Alice A"]);
    const dash = await withOrg(a.orgId, (db) => getDashboard(db, a.owner, { date }));
    expect(dash.empty ? 0 : dash.totals.reservations).toBe(1);
    const an = await withOrg(a.orgId, (db) => getAnalytics(db, a.owner, { from: date, to: date }));
    expect(an.summary.reservations).toBe(1);
    // asking for another tenant's location is refused / empty
    const foreign = await withOrg(a.orgId, (db) => getAnalytics(db, a.owner, { from: date, to: date, locationId: b.locationId }));
    expect(foreign.summary.reservations).toBe(0);
    expect(foreign.locations).toHaveLength(0);
  });

  it("restricts staff to their assigned locations", async () => {
    const t = await createTenant();
    const loc2 = await withSystem(async (db) => (await db.one<{ id: string }>(`INSERT INTO locations (org_id, name, slug) VALUES ($1,'Second',$2) RETURNING id`, [t.orgId, `second-${t.slug}`])).id);
    const host = await addMember(t, "host", [loc2]);
    await expect(createReservation(host, booking(t))).rejects.toMatchObject({ code: "LOCATION_FORBIDDEN" });
    const res = await createReservation(t.owner, booking(t));
    await expect(withOrg(t.orgId, (db) => getReservation(db, host, res.id))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(transitionReservation(host, res.id, { action: "cancel" })).rejects.toMatchObject({ code: "LOCATION_FORBIDDEN" });
  });
});
