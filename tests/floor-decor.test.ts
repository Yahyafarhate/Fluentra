import { describe, expect, it } from "vitest";
import { withOrg, withSystem } from "@/lib/db";
import { booking, createTenant, futureDate } from "./helpers";
import { createReservation } from "@/server/reservations/service";
import { createItem, deleteItem, getFloorState, updateItem } from "@/server/floor/service";

describe("floor plan decor", () => {
  const setup = async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 8 }, { name: "B", capacity: 4 }] });
    await withSystem(async (db) => {
      await db.exec(`UPDATE tables SET x=0, y=0, w=90, h=70 WHERE id=$1`, [t.tableIds[0]]);
      await db.exec(`UPDATE tables SET x=300, y=0, w=90, h=70 WHERE id=$1`, [t.tableIds[1]]);
    });
    return t;
  };

  it("creates, edits and deletes decor, and returns it with the floor state", async () => {
    const t = await setup();
    const { id } = await withOrg(t.orgId, (db) => createItem(db, t.owner, { locationId: t.locationId, floorId: t.floorId, kind: "pool", label: "Piscine", x: 100, y: 0, w: 120, h: 300, rotation: 0 }));
    await withOrg(t.orgId, (db) => updateItem(db, t.owner, id, { label: "Bassin", rotation: 90 }));
    const st = await withOrg(t.orgId, (db) => getFloorState(db, t.owner, t.locationId));
    expect(st.items).toMatchObject([{ id, kind: "pool", label: "Bassin", rotation: 90 }]);
    await withOrg(t.orgId, (db) => deleteItem(db, t.owner, id));
    expect((await withOrg(t.orgId, (db) => getFloorState(db, t.owner, t.locationId))).items).toHaveLength(0);
  });

  it("rejects a floor from another restaurant and another organization's items", async () => {
    const a = await setup(); const b = await setup();
    await expect(withOrg(a.orgId, (db) => createItem(db, a.owner, { locationId: a.locationId, floorId: b.floorId, kind: "wall", x: 0, y: 0, w: 100, h: 10, rotation: 0 }))).rejects.toMatchObject({ status: 404 });
    const { id } = await withOrg(b.orgId, (db) => createItem(db, b.owner, { locationId: b.locationId, floorId: b.floorId, kind: "wall", x: 0, y: 0, w: 100, h: 10, rotation: 0 }));
    await expect(withOrg(a.orgId, (db) => updateItem(db, a.owner, id, { label: "x" }))).rejects.toMatchObject({ status: 404 });
    await expect(withOrg(a.orgId, (db) => deleteItem(db, a.owner, id))).rejects.toMatchObject({ status: 404 });
  });

  it("a pool between two tables stops them being grouped for a large party; decor that is not an obstacle does not", async () => {
    const t = await setup();
    const res = () => createReservation(t.owner, booking(t, { date: futureDate(3), time: "20:00", partySize: 12 }));
    const door = await withOrg(t.orgId, (db) => createItem(db, t.owner, { locationId: t.locationId, floorId: t.floorId, kind: "door", x: 150, y: 0, w: 20, h: 300, rotation: 0 }));
    const pool = await withOrg(t.orgId, (db) => createItem(db, t.owner, { locationId: t.locationId, floorId: t.floorId, kind: "pool", x: 150, y: 0, w: 20, h: 300, rotation: 0 }));
    await expect(res()).rejects.toMatchObject({ code: "NO_AVAILABILITY" });
    await withOrg(t.orgId, (db) => deleteItem(db, t.owner, pool.id));
    expect((await res()).tableIds).toHaveLength(2);                       // the door alone never blocks
    void door;
  });
});
