import { describe, expect, it } from "vitest";
import { api } from "./api";
import { createTenant, futureDate } from "./helpers";
import { withOrg, withSystem } from "@/lib/db";

describe("seating areas on the public booking page", () => {
  it("only offers (and books) tables in the area the guest chose", async () => {
    const t = await createTenant({ tables: [{ name: "In1", capacity: 2 }, { name: "Terr1", capacity: 2 }] });
    const [inside, terrace] = await withSystem(async (db) => {
      const a = await db.one<{ id: string }>(`INSERT INTO sections (org_id, location_id, name, kind) VALUES ($1,$2,'Salle','indoor') RETURNING id`, [t.orgId, t.locationId]);
      const b = await db.one<{ id: string }>(`INSERT INTO sections (org_id, location_id, name, kind) VALUES ($1,$2,'Terrasse','outdoor') RETURNING id`, [t.orgId, t.locationId]);
      await db.exec(`UPDATE tables SET section_id=$2 WHERE id=$1`, [t.tables.In1, a.id]);
      await db.exec(`UPDATE tables SET section_id=$2 WHERE id=$1`, [t.tables.Terr1, b.id]);
      return [a.id, b.id];
    });
    const date = futureDate(4);
    const profile = await api.pub("GET", `/restaurants/${t.slug}`, { ip: "80.0.0.1" });
    expect(profile.json.seatingOptions.map((s: { name: string }) => s.name).sort()).toEqual(["Salle", "Terrasse"]);

    const book = (sectionId: string | undefined, phone: string, ip: string) =>
      api.pub("POST", `/restaurants/${t.slug}/bookings`, { ip, body: { date, time: "20:00", partySize: 2, guestName: "Areas", guestPhone: phone, elapsedMs: 4000, sectionId } });
    expect((await book(terrace, "0600000061", "80.0.1.1")).status).toBe(201);
    // terrace is now taken at 20:00; guests asking for it see no availability, but "no preference" still gets the indoor table
    const slots = await api.pub("GET", `/restaurants/${t.slug}/slots?date=${date}&partySize=2&sectionId=${terrace}`, { ip: "80.0.1.2" });
    expect(slots.json.slots.find((s: { time: string }) => s.time === "20:00").available).toBe(false);
    expect((await book(terrace, "0600000062", "80.0.1.3")).json.error.code).toBe("NO_AVAILABILITY");
    expect((await book(undefined, "0600000063", "80.0.1.4")).status).toBe(201);
    const rows = await withOrg(t.orgId, (db) => db.query<{ name: string }>(`SELECT tb.name FROM reservation_tables rt JOIN tables tb ON tb.id=rt.table_id ORDER BY tb.name`));
    expect(rows.map((r) => r.name)).toEqual(["In1", "Terr1"]);
    void inside;
  });
});
