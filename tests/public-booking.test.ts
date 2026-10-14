import { describe, expect, it } from "vitest";
import { api, loginAs } from "./api";
import { createTenant, futureDate } from "./helpers";
import { withSystem } from "@/lib/db";
import { runDueJobs } from "@/server/notifications/jobs";

const book = (slug: string, over: Record<string, unknown> = {}, ip = "20.0.0.1") =>
  api.pub("POST", `/restaurants/${slug}/bookings`, { ip, body: { date: futureDate(4), time: "19:00", partySize: 2, guestName: "Salma El Idrissi", guestPhone: `06${Math.floor(10000000 + Math.random() * 89999999)}`, guestEmail: "salma@example.com", elapsedMs: 5000, ...over } });

describe("public booking API", () => {
  it("exposes only public restaurant data", async () => {
    const t = await createTenant();
    await withSystem((db) => db.exec(`UPDATE locations SET description='Cuisine marocaine', policy_text='Annulation gratuite'  WHERE id=$1`, [t.locationId]));
    const r = await api.pub("GET", `/restaurants/${t.slug}`, { ip: "20.1.0.1" });
    expect(r.status).toBe(200);
    expect(r.json.name).toContain("Resto");
    const blob = JSON.stringify(r.json);
    for (const secret of [t.orgId, t.ownerEmail, "org_id", "orgId", "password"]) expect(blob).not.toContain(secret);
    expect((await api.pub("GET", `/restaurants/does-not-exist`, { ip: "20.1.0.1" })).status).toBe(404);
  });

  it("lists real availability and never leaks table information", async () => {
    const t = await createTenant({ tables: [{ name: "Secret-Table-9", capacity: 2 }] });
    const date = futureDate(4);
    const free = await api.pub("GET", `/restaurants/${t.slug}/slots?date=${date}&partySize=2`, { ip: "20.2.0.1" });
    expect(free.status).toBe(200);
    expect(free.json.slots.find((s: { time: string }) => s.time === "19:00").available).toBe(true);
    expect(free.text).not.toContain("Secret-Table-9");
    expect(free.text).not.toContain("tableIds");
    expect((await book(t.slug, { date }, "20.2.0.2")).status).toBe(201);
    const after = await api.pub("GET", `/restaurants/${t.slug}/slots?date=${date}&partySize=2`, { ip: "20.2.0.1" });
    expect(after.json.slots.find((s: { time: string }) => s.time === "19:00").available).toBe(false);
    const big = await api.pub("GET", `/restaurants/${t.slug}/slots?date=${date}&partySize=30`, { ip: "20.2.0.1" });
    expect(big.json.slots.every((s: { available: boolean }) => !s.available)).toBe(true);
  });

  it("creates a real reservation, confirmation message and secure manage link", async () => {
    const t = await createTenant();
    const r = await book(t.slug, {}, "20.3.0.1");
    expect(r.status).toBe(201);
    expect(r.json.status).toBe("confirmed");
    expect(r.json.manageUrl).toMatch(/^\/r\//);
    await runDueJobs(50);
    const cookie = await loginAs(t.ownerEmail, undefined, "20.3.0.2");
    const list = await api.v1("GET", `/reservations?locationId=${t.locationId}&q=salma`, { cookie });
    expect(list.json.reservations).toHaveLength(1);
    expect(list.json.reservations[0].source).toBe("online");
    const notes = await api.v1("GET", `/notifications`, { cookie });
    const conf = notes.json.notifications.find((n: { templateKey: string }) => n.templateKey === "booking_confirmation");
    expect(conf).toBeTruthy();
    expect(conf.status).toBe("simulated"); // clearly NOT "sent": no provider connected
  });

  it("guests manage their booking only via the signed link; tampered tokens fail", async () => {
    const t = await createTenant();
    const date = futureDate(5);
    const r = await book(t.slug, { date }, "20.4.0.1");
    const token = r.json.manageUrl.replace("/r/", "");
    const view = await api.pub("GET", `/reservations/${token}`, { ip: "20.4.0.2" });
    expect(view.status).toBe(200);
    expect(view.json.canCancel).toBe(true);
    expect(JSON.stringify(view.json)).not.toMatch(/internal|orgId/i);
    expect((await api.pub("GET", `/reservations/${token.slice(0, -2)}xx`, { ip: "20.4.0.2" })).status).toBe(404);
    expect((await api.pub("GET", `/reservations/${crypto.randomUUID()}.${"a".repeat(32)}`, { ip: "20.4.0.2" })).status).toBe(404);
    const mod = await api.pub("PATCH", `/reservations/${token}`, { ip: "20.4.0.3", body: { time: "20:30", partySize: 3 } });
    expect(mod.status).toBe(200);
    const after = await api.pub("GET", `/reservations/${token}`, { ip: "20.4.0.2" });
    expect(after.json.time).toBe("20:30"); expect(after.json.partySize).toBe(3);
    const cancel = await api.pub("DELETE", `/reservations/${token}`, { ip: "20.4.0.4" });
    expect(cancel.status).toBe(200);
    expect((await api.pub("GET", `/reservations/${token}`, { ip: "20.4.0.2" })).json.status).toBe("cancelled");
    expect((await api.pub("DELETE", `/reservations/${token}`, { ip: "20.4.0.4" })).status).toBe(409);
  });

  it("enforces the cancellation deadline", async () => {
    const t = await createTenant();
    await withSystem((db) => db.exec(`UPDATE locations SET cancel_deadline_hours=24*30 WHERE id=$1`, [t.locationId]));
    const r = await book(t.slug, { date: futureDate(5) }, "20.5.0.1");
    const token = r.json.manageUrl.replace("/r/", "");
    const c = await api.pub("DELETE", `/reservations/${token}`, { ip: "20.5.0.2" });
    expect(c.status).toBe(403);
    expect(c.json.error.code).toBe("CANCEL_DEADLINE_PASSED");
  });

  it("validates input and enforces online rules", async () => {
    const t = await createTenant();
    expect((await book(t.slug, { guestName: "" }, "20.6.1.1")).status).toBe(422);
    expect((await book(t.slug, { partySize: 0 }, "20.6.1.2")).status).toBe(422);
    expect((await book(t.slug, { date: "2026-13-45" }, "20.6.1.3")).status).toBe(422);
    expect((await book(t.slug, { time: "25:99" }, "20.6.1.4")).status).toBe(422);
    expect((await book(t.slug, { guestEmail: "not-an-email" }, "20.6.1.5")).status).toBe(422);
    expect((await book(t.slug, { guestPhone: "123", guestEmail: undefined }, "20.6.1.6")).status).toBe(400);
    expect((await book(t.slug, { guestPhone: undefined, guestEmail: undefined }, "20.6.1.7")).status).toBe(400); // contact required
    expect((await book(t.slug, { partySize: 12 }, "20.6.1.8")).json.error.code).toBe("PARTY_TOO_LARGE");
    expect((await book(t.slug, { time: "19:07" }, "20.6.1.9")).json.error.code).toBe("INVALID_SLOT");
    expect((await book(t.slug, { time: "03:00" }, "20.6.1.10")).json.error.code).toBe("CLOSED");
    expect((await book(t.slug, { date: futureDate(-1) }, "20.6.1.11")).status).toBeGreaterThanOrEqual(400);
    expect((await book(t.slug, { date: futureDate(400) }, "20.6.1.12")).json.error.code).toBe("TOO_FAR");
    await withSystem((db) => db.exec(`UPDATE locations SET online_booking_enabled=false WHERE id=$1`, [t.locationId]));
    expect((await book(t.slug, {}, "20.6.1.13")).json.error.code).toBe("ONLINE_BOOKING_DISABLED");
  });

  it("blocks bots (honeypot, instant submits) and rate-limits abusive clients", async () => {
    const t = await createTenant();
    expect((await book(t.slug, { website: "http://spam" }, "20.7.0.1")).json.error.code).toBe("SPAM_DETECTED");
    expect((await book(t.slug, { elapsedMs: 100 }, "20.7.0.1")).json.error.code).toBe("TOO_FAST");
    let last = 0;
    for (let i = 0; i < 20; i++) last = (await book(t.slug, { guestName: "" }, "20.7.0.9")).status;
    expect(last).toBe(429);
    // per-contact throttle even from fresh IPs
    let status = 0;
    for (let i = 0; i < 8; i++) status = (await book(t.slug, { date: futureDate(10 + i), guestPhone: "0600000042" }, `20.7.1.${i}`)).status;
    expect(status).toBe(429);
  });

  it("holds a slot temporarily so others cannot take it, and consumes the hold on booking", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 2 }] });
    const date = futureDate(6);
    const h = await api.pub("POST", `/restaurants/${t.slug}/holds`, { ip: "20.8.0.1", body: { date, time: "19:00", partySize: 2 } });
    expect(h.status).toBe(201);
    expect((await book(t.slug, { date, guestPhone: "0600000002" }, "20.8.0.2")).status).toBe(409); // held for someone else
    const mine = await book(t.slug, { date, holdToken: h.json.holdToken, guestPhone: "0600000003" }, "20.8.0.3");
    expect(mine.status).toBe(201);
    const left = await withSystem((db) => db.one<{ n: number }>(`SELECT count(*)::int n FROM slot_holds WHERE location_id=$1`, [t.locationId]));
    expect(left.n).toBe(0);
  });

  it("deposit-required bookings stay pending and say honestly that payment is not connected", async () => {
    const t = await createTenant({ tables: [{ name: "Big", capacity: 8 }] });
    await withSystem((db) => db.exec(`UPDATE locations SET deposit_enabled=true, deposit_amount_per_guest=100, deposit_min_party=4, max_party_online=8 WHERE id=$1`, [t.locationId]));
    const r = await book(t.slug, { partySize: 6 }, "20.9.0.1");
    expect(r.status).toBe(201);
    expect(r.json.status).toBe("pending");
    expect(r.json.deposit.amount).toBe(600);
    expect(r.json.deposit.note).toMatch(/not connected/i);
  });
});
