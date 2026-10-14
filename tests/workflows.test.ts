import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { api, loginAs } from "./api";
import { addMember, booking, createTenant, futureDate, PASSWORD } from "./helpers";
import { createReservation, seatWalkIn, transitionReservation } from "@/server/reservations/service";
import { withOrg, withSystem } from "@/lib/db";
import { getAnalytics, toCsv, forecastCovers, pct } from "@/server/analytics/service";
import { addToWaitlist, listWaitlist, waitlistAction } from "@/server/waitlist/service";
import { mergeCustomers, anonymizeCustomer, exportCustomerData, queryCustomers, recordConsent } from "@/server/customers/service";
import { executeCampaign, campaignResults, unsubscribeByToken } from "@/server/marketing/service";
import { unsubscribeToken } from "@/server/notifications/service";
import { runDueJobs } from "@/server/notifications/jobs";
import { todayLocal } from "@/lib/tz";

describe("waitlist workflow", () => {
  it("add → estimate → notify → seat, with priority ordering and honest estimates", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 2 }] });
    const occupied = await seatWalkIn(t.owner, { locationId: t.locationId, partySize: 2, guestName: "Seated" });
    const regular = await withOrg(t.orgId, (db) => addToWaitlist(db, t.owner, { locationId: t.locationId, name: "Regular", phone: "0611111111", partySize: 2 }));
    const accessible = await withOrg(t.orgId, (db) => addToWaitlist(db, t.owner, { locationId: t.locationId, name: "Accessible", phone: "0622222222", partySize: 2, priorityReason: "accessibility" }));
    expect(regular.estimate.minutes).toBeGreaterThan(0);
    const list = await withOrg(t.orgId, (db) => listWaitlist(db, t.owner, t.locationId));
    expect(list.entries.map((e) => e.name)).toEqual(["Accessible", "Regular"]); // priority first
    expect(list.entries[1].estimatedWaitMin!).toBeGreaterThan(list.entries[0].estimatedWaitMin!);
    expect(list.disclaimer).toMatch(/not guaranteed/i);
    await expect(withOrg(t.orgId, (db) => addToWaitlist(db, t.owner, { locationId: t.locationId, name: "Dup", phone: "0611111111", partySize: 2 }))).rejects.toMatchObject({ code: "DUPLICATE_WAITLIST" });
    // table not free yet
    await expect(waitlistAction(t.owner, accessible.id, { action: "seat" })).rejects.toMatchObject({ code: "NO_AVAILABILITY" });
    await transitionReservation(t.owner, occupied.id, { action: "complete" });
    await withOrg(t.orgId, (db) => db.exec(`UPDATE tables SET status='available'`));
    await waitlistAction(t.owner, accessible.id, { action: "notify" });
    await runDueJobs(50);
    const notif = await withOrg(t.orgId, (db) => db.query<{ templateKey: string }>(`SELECT template_key FROM notifications WHERE template_key='waitlist_ready'`));
    expect(notif).toHaveLength(1);
    const seated = await waitlistAction(t.owner, accessible.id, { action: "seat" });
    expect(seated.reservationId).toBeTruthy();
    const e = await withOrg(t.orgId, (db) => db.one<{ status: string; customerId: string | null; reservationId: string }>(`SELECT status, customer_id, reservation_id FROM waitlist_entries WHERE id=$1`, [accessible.id]));
    expect(e.status).toBe("seated"); expect(e.customerId).toBeTruthy(); expect(e.reservationId).toBe(seated.reservationId);
    await expect(waitlistAction(t.owner, accessible.id, { action: "remove" })).rejects.toMatchObject({ code: "WAITLIST_NOT_ACTIVE" });
    await waitlistAction(t.owner, regular.id, { action: "remove" });
    const stats = (await withOrg(t.orgId, (db) => listWaitlist(db, t.owner, t.locationId))).stats;
    expect(stats.total).toBe(2); expect(stats.seated).toBe(1); expect(stats.conversionPct).toBe(50);
  });

  it("public waitlist is opt-in and returns an estimate flagged as non-guaranteed", async () => {
    const t = await createTenant();
    const off = await api.pub("POST", `/restaurants/${t.slug}/waitlist`, { ip: "40.0.0.1", body: { name: "Walker", phone: "0633333333", partySize: 2 } });
    expect(off.status).toBe(403);
    await withSystem((db) => db.exec(`UPDATE locations SET public_waitlist_enabled=true WHERE id=$1`, [t.locationId]));
    const on = await api.pub("POST", `/restaurants/${t.slug}/waitlist`, { ip: "40.0.0.1", body: { name: "Walker", phone: "0633333333", partySize: 2 } });
    expect(on.status).toBe(201);
    expect(on.json.isEstimate).toBe(true);
    const token = on.json.statusUrl.replace("/w/", "");
    const st = await api.pub("GET", `/waitlist/${token}`, { ip: "40.0.0.2" });
    expect(st.json.disclaimer).toMatch(/not guaranteed/i);
    expect((await api.pub("DELETE", `/waitlist/${token}`, { ip: "40.0.0.2" })).status).toBe(200);
  });
});

describe("analytics definitions", () => {
  it("computes reservation, cover, cancellation and no-show metrics from real data; spend only when recorded", async () => {
    const t = await createTenant({ tables: [{ name: "A", capacity: 4 }, { name: "B", capacity: 4 }, { name: "C", capacity: 4 }, { name: "D", capacity: 4 }] });
    const date = futureDate(5);
    const mk = (time: string, party: number) => createReservation(t.owner, booking(t, { date, time, partySize: party }));
    const r1 = await mk("12:00", 2); const r2 = await mk("13:00", 4); const r3 = await mk("14:00", 3); const r4 = await mk("15:00", 2);
    await transitionReservation(t.owner, r1.id, { action: "cancel" });
    await transitionReservation(t.owner, r2.id, { action: "no_show", force: true });
    await withSystem((db) => db.exec(`UPDATE reservations SET status='completed' WHERE id=$1`, [r3.id]));
    await withSystem((db) => db.exec(`UPDATE reservations SET status='completed' WHERE id=$1`, [r4.id]));
    const a = await withOrg(t.orgId, (db) => getAnalytics(db, t.owner, { from: date, to: date }));
    expect(a.summary.bookingsIncludingCancelled).toBe(4);
    expect(a.summary.reservations).toBe(2);           // excludes cancelled + no-show
    expect(a.summary.covers).toBe(5);                  // 3 + 2, not 11
    expect(a.summary.cancellationRatePct).toBe(25);    // 1 / 4
    expect(a.summary.noShowRatePct).toBe(33.3);        // 1 / (2 completed + 1 no-show)
    expect(a.revenue.recorded).toBeNull();             // no spend recorded → no revenue shown
    expect(a.revenue.note).toMatch(/No spend recorded/);
    expect(a.byHour.map((h) => h.hour)).toEqual([14, 15]);
    expect(a.bySource[0].source).toBe("staff");
  });

  it("averages spend only over visits that have spend, and reports coverage", async () => {
    const t = await createTenant();
    const w1 = await seatWalkIn(t.owner, { locationId: t.locationId, partySize: 2 });
    await transitionReservation(t.owner, w1.id, { action: "complete", spendAmount: 500 });
    await withOrg(t.orgId, (db) => db.exec(`UPDATE tables SET status='available'`));
    const w2 = await seatWalkIn(t.owner, { locationId: t.locationId, partySize: 4 });
    await transitionReservation(t.owner, w2.id, { action: "complete" });
    const today = await withOrg(t.orgId, (db) => todayLocal(db, "Africa/Casablanca"));
    const a = await withOrg(t.orgId, (db) => getAnalytics(db, t.owner, { from: today, to: today }));
    expect(a.revenue.recorded).toBe(500);
    expect(a.revenue.avgSpendPerGuest).toBe(250); // 500 / 2 guests with spend (not / 6)
    expect(a.revenue.visits).toBe(2); expect(a.revenue.visitsWithSpend).toBe(1);
  });

  it("pure helpers: percentages, forecast and CSV injection protection", () => {
    expect(pct(1, 3)).toBe(33.3); expect(pct(0, 0)).toBeNull();
    const hist = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"].map((date, i) => ({ date, covers: 40 + i * 10 }));
    expect(forecastCovers(hist, "2026-10-05")).toEqual({ covers: 55, samples: 4 });
    expect(forecastCovers(hist.slice(0, 2), "2026-10-05")).toBeNull();
    const csv = toCsv([{ name: "=HYPERLINK(\"http://evil\")", note: "a,b" }, { name: "+1", note: "ok" }]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+1");
    expect(csv).toContain('"a,b"');
  });

  it("uses the restaurant's timezone for service dates", async () => {
    const t = await createTenant();
    await withSystem((db) => db.exec(`UPDATE locations SET timezone='Pacific/Auckland' WHERE id=$1`, [t.locationId]));
    const date = futureDate(4, "Pacific/Auckland");
    const r = await createReservation(t.owner, booking(t, { date, time: "00:30", force: true }));
    const row = await withSystem((db) => db.one<{ serviceDate: string; utcHour: number }>(`SELECT service_date, extract(hour from start_at at time zone 'UTC')::int AS utc_hour FROM reservations WHERE id=$1`, [r.id]));
    expect(row.serviceDate).toBe(date);
    expect(row.utcHour).toBe(11); // 00:30 NZDT(+13) = 11:30 UTC the previous day
  });
});

describe("CRM, privacy and marketing", () => {
  it("merges duplicates with an audit trail and moves history", async () => {
    const t = await createTenant();
    await createReservation(t.owner, booking(t, { guestName: "Amine B", guestPhone: "0600000011", time: "12:00" }));
    await createReservation(t.owner, booking(t, { guestName: "Amine Benjelloun", guestEmail: "amine@x.dev", guestPhone: "0600000012", time: "19:00" }));
    const [a, b] = (await withOrg(t.orgId, (db) => queryCustomers(db, t.orgId, {}, { sort: "created" }))).rows.reverse();
    await withOrg(t.orgId, (db) => mergeCustomers(db, t.owner, a.id, b.id));
    const rows = await withOrg(t.orgId, (db) => queryCustomers(db, t.orgId, {}));
    expect(rows.rows).toHaveLength(1);
    const res = await withOrg(t.orgId, (db) => db.query(`SELECT customer_id FROM reservations`));
    expect(new Set(res.map((r) => r.customerId)).size).toBe(1);
    const audit = await withOrg(t.orgId, (db) => db.query(`SELECT metadata FROM audit_logs WHERE action='customer.merge'`));
    expect(audit).toHaveLength(1);
  });

  it("exports and erases personal data (right of access / erasure) but keeps anonymous statistics", async () => {
    const t = await createTenant();
    const r = await createReservation(t.owner, booking(t, { guestName: "Leila Z", guestEmail: "leila@x.dev", guestPhone: "0600000021", specialRequests: "nut allergy" }));
    const c = await withOrg(t.orgId, (db) => db.one<{ id: string }>(`SELECT id FROM customers`));
    const exp = await withOrg(t.orgId, (db) => exportCustomerData(db, t.owner, c.id));
    expect(JSON.stringify(exp)).toContain("leila@x.dev");
    await withOrg(t.orgId, (db) => anonymizeCustomer(db, t.owner, t.orgId, c.id));
    const after = await withOrg(t.orgId, (db) => db.one<{ guestName: string; guestEmail: string | null; partySize: number }>(`SELECT guest_name, guest_email, party_size FROM reservations WHERE id=$1`, [r.id]));
    expect(after).toMatchObject({ guestName: "Anonymized guest", guestEmail: null, partySize: 2 });
    const n = await withOrg(t.orgId, (db) => db.query(`SELECT to_address FROM notifications`));
    expect(n.every((x) => x.toAddress === "[erased]")).toBe(true);
  });

  it("campaigns only reach consenting guests, deliver as simulated, and keep delivery/engagement/bookings separate", async () => {
    const t = await createTenant();
    const cookie = await loginAs(t.ownerEmail, PASSWORD, "50.0.0.1");
    const mkGuest = async (name: string, phone: string, email: string, consent: boolean) => {
      await createReservation(t.owner, booking(t, { guestName: name, guestPhone: phone, guestEmail: email, time: `${12 + Math.floor(Math.random() * 8)}:00`, allowDuplicate: true, consent: { email: consent } }));
    };
    await mkGuest("Consenting One", "0600000031", "c1@x.dev", true);
    await mkGuest("Consenting Two", "0600000032", "c2@x.dev", true);
    await mkGuest("No Consent", "0600000033", "c3@x.dev", false);
    const seg = await api.v1("POST", "/marketing/segments", { cookie, body: { name: "All guests", criteria: {} } });
    expect(seg.status).toBe(201);
    const camp = await api.v1("POST", "/marketing/campaigns", { cookie, body: { name: "Autumn menu", channel: "email", segmentId: seg.json.id, subject: "Menu d'automne", body: "Bonjour {{guest_name}}, découvrez notre menu. {{booking_link}}" } });
    const aud = await api.v1("GET", `/marketing/campaigns/${camp.json.id}/audience`, { cookie });
    expect(aud.json).toMatchObject({ recipients: 2, segmentSize: 3, excluded: 1 });
    expect(aud.json.providerStatus.state).toBe("simulated");
    const launch = await api.v1("POST", `/marketing/campaigns/${camp.json.id}/launch`, { cookie, body: {} });
    expect(launch.json.status).toBe("sending");
    await runDueJobs(50); await runDueJobs(50);
    const res = await api.v1("GET", `/marketing/campaigns/${camp.json.id}/results`, { cookie });
    expect(res.json.delivery.recipients).toBe(2);
    expect(res.json.delivery.simulated).toBe(2);
    expect(res.json.delivery.delivered).toBe(0);      // never inflated
    expect(res.json.engagement.opened).toBe(0);       // never inferred
    expect(res.json.bookings.attributed).toBe(0);
    const bodies = await withOrg(t.orgId, (db) => db.query<{ body: string }>(`SELECT body FROM notifications WHERE campaign_id=$1`, [camp.json.id]));
    expect(bodies.every((b) => /\/u\//.test(b.body))).toBe(true); // unsubscribe link always present
    // idempotent re-run
    await executeCampaign(t.orgId, camp.json.id);
    expect((await withOrg(t.orgId, (db) => db.query(`SELECT 1 FROM notifications WHERE campaign_id=$1`, [camp.json.id]))).length).toBe(2);
    // unsubscribe → no longer in audience
    const guest = await withOrg(t.orgId, (db) => db.one<{ id: string }>(`SELECT id FROM customers WHERE name='Consenting One'`));
    await unsubscribeByToken(unsubscribeToken(guest.id, "email"));
    expect((await api.v1("GET", `/marketing/campaigns/${camp.json.id}/audience`, { cookie })).json.recipients).toBe(1);
    const ledger = await withOrg(t.orgId, (db) => db.query<{ granted: boolean; source: string }>(`SELECT granted, source FROM consents WHERE customer_id=$1 ORDER BY created_at`, [guest.id]));
    expect(ledger.map((l) => l.granted)).toEqual([true, false]);
    expect(ledger[1].source).toBe("unsubscribe_link");
    await expect(unsubscribeByToken("garbage.token.value")).rejects.toMatchObject({ code: "NOT_FOUND" });
    void campaignResults; void recordConsent;
  });

  it("attributes bookings only when they carry the tracked campaign link", async () => {
    const t = await createTenant();
    const cookie = await loginAs(t.ownerEmail, PASSWORD, "50.1.0.1");
    const camp = await api.v1("POST", "/marketing/campaigns", { cookie, body: { name: "C", channel: "email", subject: "s", body: "b" } });
    const via = await api.pub("POST", `/restaurants/${t.slug}/bookings`, { ip: "50.1.1.1", body: { date: futureDate(4), time: "19:00", partySize: 2, guestName: "From Campaign", guestPhone: "0600000041", elapsedMs: 4000, campaignId: camp.json.id } });
    expect(via.status).toBe(201);
    const res = await api.v1("GET", `/marketing/campaigns/${camp.json.id}/results`, { cookie });
    expect(res.json.bookings.attributed).toBe(1);
    // a foreign campaign id is silently ignored (no cross-tenant attribution)
    const other = await createTenant();
    const oc = await loginAs(other.ownerEmail, PASSWORD, "50.1.0.2");
    const foreign = await api.v1("POST", "/marketing/campaigns", { cookie: oc, body: { name: "Other", channel: "email", subject: "s", body: "b" } });
    await api.pub("POST", `/restaurants/${t.slug}/bookings`, { ip: "50.1.1.2", body: { date: futureDate(4), time: "20:00", partySize: 2, guestName: "X", guestPhone: "0600000042", elapsedMs: 4000, campaignId: foreign.json.id } });
    const res2 = await api.v1("GET", `/marketing/campaigns/${foreign.json.id}/results`, { cookie: oc });
    expect(res2.json.bookings.attributed).toBe(0);
  });
});

describe("plan limits & super admin", () => {
  it("enforces plan limits and gated features on the server", async () => {
    const t = await createTenant({ plan: "starter" });
    const cookie = await loginAs(t.ownerEmail, PASSWORD, "60.0.0.1");
    expect((await api.v1("POST", "/locations", { cookie, body: { name: "Second" } })).status).toBe(403);   // multi_location not in plan
    expect((await api.v1("GET", "/marketing/campaigns", { cookie })).json.error.code).toBe("FEATURE_NOT_IN_PLAN");
    expect((await api.v1("POST", "/automations", { cookie, body: { name: "x", trigger: "reservation_created", channel: "email", templateKey: "booking_pending" } })).json.error.code).toBe("FEATURE_NOT_IN_PLAN");
    expect((await api.v1("GET", `/analytics/export.csv?from=${futureDate(-1)}&to=${futureDate(0)}`, { cookie })).json.error.code).toBe("FEATURE_NOT_IN_PLAN");
    expect((await api.v1("PATCH", `/locations/${t.locationId}`, { cookie, body: { depositEnabled: true } })).json.error.code).toBe("FEATURE_NOT_IN_PLAN");
    await withSystem((db) => db.exec(`UPDATE plans SET max_monthly_reservations=2 WHERE id='starter'`));
    try {
      await createReservation(t.owner, booking(t, { time: "12:00" }));
      await createReservation(t.owner, booking(t, { time: "14:00" }));
      await expect(createReservation(t.owner, booking(t, { time: "16:00" }))).rejects.toMatchObject({ code: "PLAN_LIMIT" });
      const pub = await api.pub("POST", `/restaurants/${t.slug}/bookings`, { ip: "60.0.0.2", body: { date: futureDate(4), time: "19:00", partySize: 2, guestName: "G", guestPhone: "0600000051", elapsedMs: 4000 } });
      expect(pub.status).toBe(402);
    } finally { await withSystem((db) => db.exec(`UPDATE plans SET max_monthly_reservations=500 WHERE id='starter'`)); }
  });

  it("limits user seats, and an expired trial stops new reservations", async () => {
    const t = await createTenant({ plan: "starter" });
    const cookie = await loginAs(t.ownerEmail, PASSWORD, "60.1.0.1");
    for (let i = 0; i < 4; i++) expect((await api.v1("POST", "/team/invitations", { cookie, body: { email: `s${i}-${randomUUID().slice(0, 4)}@x.dev`, role: "host" } })).status).toBe(201);
    expect((await api.v1("POST", "/team/invitations", { cookie, body: { email: "overflow@x.dev", role: "host" } })).status).toBe(402);
    const t2 = await createTenant({ plan: "pro", status: "trial" });
    await withSystem((db) => db.exec(`UPDATE organizations SET trial_ends_at = now() - interval '1 day' WHERE id=$1`, [t2.orgId]));
    await expect(createReservation(t2.owner, booking(t2))).rejects.toMatchObject({ code: "PLAN_LIMIT" });
  });

  it("super admin can create, suspend and reactivate tenants without touching their data", async () => {
    const sa = await withSystem(async (db) => {
      const email = `super-${randomUUID().slice(0, 6)}@platform.dev`;
      const { hashPassword } = await import("@/lib/auth");
      await db.exec(`INSERT INTO users (email, password_hash, name, is_super_admin) VALUES ($1,$2,'Platform',true)`, [email, await hashPassword(PASSWORD)]);
      return email;
    });
    const cookie = await loginAs(sa, PASSWORD, "60.2.0.1");
    const created = await api.admin("POST", "/organizations", { cookie, body: { name: "Hotel Atlas", restaurantName: "Atlas Rooftop", planId: "pro", ownerName: "GM", ownerEmail: `gm-${randomUUID().slice(0, 5)}@hotel.dev`, ownerPassword: "Hotel-Pass-12345" } });
    expect(created.status).toBe(201);
    const orgId = created.json.id;
    const ownerLogin = await withSystem((db) => db.one<{ email: string }>(`SELECT u.email FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.org_id=$1`, [orgId]));
    const ownerCookie = await loginAs(ownerLogin.email, "Hotel-Pass-12345", "60.2.0.2");
    expect((await api.v1("GET", "/locations", { cookie: ownerCookie })).json).toHaveLength(1);
    expect((await api.admin("POST", `/organizations/${orgId}/suspend`, { cookie, body: { reason: "Non-payment" } })).status).toBe(200);
    expect((await api.v1("GET", "/locations", { cookie: ownerCookie })).status).toBe(401); // sessions revoked
    expect((await api.auth("GET", "/me", { cookie: ownerCookie })).status).toBe(401);
    const stillThere = await withSystem((db) => db.one<{ n: number }>(`SELECT count(*)::int n FROM locations WHERE org_id=$1`, [orgId]));
    expect(stillThere.n).toBe(1);
    expect((await api.admin("POST", `/organizations/${orgId}/reactivate`, { cookie })).status).toBe(200);
    const again = await loginAs(ownerLogin.email, "Hotel-Pass-12345", "60.2.0.3");
    expect((await api.v1("GET", "/locations", { cookie: again })).status).toBe(200);
    const audit = await api.admin("GET", "/audit", { cookie });
    expect(audit.json.entries.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["admin.org_create", "admin.org_suspend", "admin.org_reactivate"]));
    const overview = await api.admin("GET", "/overview", { cookie });
    expect(overview.json.health.database.ok).toBe(true);
  });
});

describe("input validation & uploads", () => {
  it("rejects malformed input with 422 and field-level details; malformed ids with 4xx not 500", async () => {
    const t = await createTenant();
    const cookie = await loginAs(t.ownerEmail, PASSWORD, "70.0.0.1");
    const r = await api.v1("POST", "/reservations", { cookie, body: { locationId: "nope", date: "tomorrow", time: "7pm", partySize: -2, guestName: "" } });
    expect(r.status).toBe(422);
    expect(r.json.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(["locationId", "date", "time", "partySize", "guestName"]));
    expect((await api.v1("GET", "/reservations/not-a-uuid", { cookie })).status).toBe(400);
    expect((await api.v1("PATCH", `/locations/${t.locationId}`, { cookie, body: { brandColor: "red", maxParty: 0 } })).status).toBe(422);
    expect((await api.v1("PATCH", `/locations/${t.locationId}`, { cookie, body: { unknownField: 1 } })).status).toBe(422);
    expect((await api.v1("PATCH", `/locations/${t.locationId}`, { cookie, body: { maxPartyOnline: 50, maxParty: 10 } })).status).toBe(422);
    expect((await api.v1("POST", "/services", { cookie, body: { locationId: t.locationId, name: "Bad", days: [1], startTime: "20:00", lastSeating: "19:00" } })).status).toBe(422);
    expect((await api.v1("POST", "/services", { cookie, body: { locationId: t.locationId, name: "Overlap", days: [1], startTime: "11:00", lastSeating: "12:00" } })).json.error.code).toBe("SERVICE_OVERLAP");
    expect((await api.v1("POST", "/floor/tables", { cookie, body: { locationId: t.locationId, floorId: t.floorId, name: "T1", capacity: 4 } })).status).toBe(409); // duplicate name
    expect((await api.v1("POST", "/floor/tables", { cookie, body: { locationId: t.locationId, floorId: t.floorId, name: "X", capacity: 0 } })).status).toBe(422);
    expect((await api.v1("POST", "/reservations", { cookie, body: "{not json", headers: {} })).status).toBe(400);
  });

  it("accepts only real images for uploads (magic-byte check) and serves them with safe headers", async () => {
    const t = await createTenant();
    const cookie = await loginAs(t.ownerEmail, PASSWORD, "70.1.0.1");
    const html = await api.v1("POST", `/locations/${t.locationId}/upload?kind=logo`, { cookie, body: "<html><script>alert(1)</script></html>" });
    expect(html.status).toBe(400); expect(html.json.error.code).toBe("UNSUPPORTED_FILE");
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    const { call } = await import("./api");
    const { v1 } = await import("@/server/routes/v1");
    const req = new Request(`http://localhost:3000/api/v1/locations/${t.locationId}/upload?kind=logo`, { method: "POST", headers: { cookie, origin: "http://localhost:3000", "content-type": "image/png" }, body: png });
    const up = await v1.handler(req, { params: Promise.resolve({ path: ["locations", t.locationId, "upload"] }) });
    expect(up.status).toBe(201);
    const { url } = await up.json();
    const { GET } = await import("@/app/api/files/[id]/route");
    const file = await GET(new Request("http://localhost" + url), { params: Promise.resolve({ id: url.split("/").pop() }) });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    const huge = await api.v1("POST", `/locations/${t.locationId}/upload?kind=logo`, { cookie, body: "x".repeat(10) });
    expect(huge.status).toBe(400);
    void call; void addMember;
  });
});
