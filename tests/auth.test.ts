import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { api, loginAs } from "./api";
import { addMember, createTenant, PASSWORD } from "./helpers";
import { withSystem } from "@/lib/db";

describe("authentication", () => {
  it("logs in with an HttpOnly SameSite cookie and exposes /me", async () => {
    const t = await createTenant();
    const r = await api.auth("POST", "/login", { body: { email: t.ownerEmail, password: PASSWORD }, ip: "10.1.0.1" });
    expect(r.status).toBe(200);
    const cookie = r.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const me = await api.auth("GET", "/me", { cookie: cookie.split(";")[0] });
    expect(me.json.role).toBe("owner");
    expect(me.json.permissions).toContain("billing.manage");
    expect(me.json.organization.id).toBe(t.orgId);
  });

  it("returns an identical generic error for wrong password and unknown user, and never stores plaintext", async () => {
    const t = await createTenant();
    const a = await api.auth("POST", "/login", { body: { email: t.ownerEmail, password: "nope-nope-nope" }, ip: "10.1.0.2" });
    const b = await api.auth("POST", "/login", { body: { email: "ghost@nowhere.dev", password: "nope-nope-nope" }, ip: "10.1.0.2" });
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(a.json.error.message).toBe(b.json.error.message);
    const row = await withSystem((db) => db.one<{ passwordHash: string }>(`SELECT password_hash FROM users WHERE email=$1`, [t.ownerEmail]));
    expect(row.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(row.passwordHash).not.toContain(PASSWORD);
  });

  it("locks the account after repeated failures", async () => {
    const t = await createTenant();
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await api.auth("POST", "/login", { body: { email: t.ownerEmail, password: "wrong-wrong-1" }, ip: `10.2.0.${i}` })).status;
    expect(last).toBe(423);
    const ok = await api.auth("POST", "/login", { body: { email: t.ownerEmail, password: PASSWORD }, ip: "10.2.0.99" });
    expect(ok.status).toBe(423); // even the right password is refused while locked
  });

  it("rate-limits login by IP", async () => {
    let status = 0;
    for (let i = 0; i < 45; i++) status = (await api.auth("POST", "/login", { body: { email: `x${i}@x.dev`, password: "whatever-123" }, ip: "10.3.0.1" })).status;
    expect(status).toBe(429);
  });

  it("protects routes: no cookie → 401, logout invalidates the session", async () => {
    const t = await createTenant();
    expect((await api.v1("GET", "/reservations")).status).toBe(401);
    const cookie = await loginAs(t.ownerEmail, PASSWORD, "10.4.0.1");
    expect((await api.v1("GET", `/reservations?locationId=${t.locationId}`, { cookie })).status).toBe(200);
    await api.auth("POST", "/logout", { cookie });
    expect((await api.v1("GET", "/reservations", { cookie })).status).toBe(401);
  });

  it("blocks cross-origin state changes (CSRF)", async () => {
    const t = await createTenant();
    const cookie = await loginAs(t.ownerEmail, PASSWORD, "10.4.0.2");
    const r = await api.v1("PATCH", `/locations/${t.locationId}`, { cookie, body: { name: "Hacked" }, origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("CSRF");
    const noOrigin = await api.v1("PATCH", `/locations/${t.locationId}`, { cookie, body: { name: "Hacked" }, origin: null });
    expect(noOrigin.status).toBe(403);
  });

  it("password recovery issues a one-time, expiring token and revokes sessions", async () => {
    const t = await createTenant();
    const cookie = await loginAs(t.ownerEmail, PASSWORD, "10.5.0.1");
    const f = await api.auth("POST", "/forgot-password", { body: { email: t.ownerEmail }, ip: "10.5.0.1" });
    expect(f.status).toBe(200);
    const token = new URL(f.json.devLink).searchParams.get("token")!;
    const weak = await api.auth("POST", "/reset-password", { body: { token, password: "short" }, ip: "10.5.0.1" });
    expect(weak.status).toBe(422);
    const ok = await api.auth("POST", "/reset-password", { body: { token, password: "Brand-New-Pass9" }, ip: "10.5.0.1" });
    expect(ok.status).toBe(200);
    expect((await api.auth("POST", "/reset-password", { body: { token, password: "Another-Pass99" }, ip: "10.5.0.1" })).status).toBe(400); // single use
    expect((await api.auth("GET", "/me", { cookie })).status).toBe(401); // old sessions revoked
    await expect(loginAs(t.ownerEmail, "Brand-New-Pass9", "10.5.0.2")).resolves.toBeTruthy();
    // unknown email gives the same answer (no enumeration)
    const unknown = await api.auth("POST", "/forgot-password", { body: { email: "nobody@nowhere.dev" }, ip: "10.5.0.3" });
    expect(unknown.status).toBe(200);
    expect(unknown.json.devLink).toBeUndefined();
  });

  it("self-service signup creates an isolated trial organization", async () => {
    const email = `new-${randomUUID().slice(0, 6)}@resto.dev`;
    const r = await api.auth("POST", "/signup", { body: { organizationName: "Nouveau Groupe", restaurantName: "Chez Nadia", ownerName: "Nadia B", email, password: "Strong-Pass-123", city: "Rabat" }, ip: "10.6.0.1" });
    expect(r.status).toBe(201);
    const cookie = r.headers.get("set-cookie")!.split(";")[0];
    const me = await api.auth("GET", "/me", { cookie });
    expect(me.json.role).toBe("owner");
    expect(me.json.locations).toHaveLength(1);
    expect(me.json.organization.status).toBe("trial");
    const dup = await api.auth("POST", "/signup", { body: { organizationName: "Other", restaurantName: "Other", ownerName: "Other", email, password: "Strong-Pass-123" }, ip: "10.6.0.2" });
    expect(dup.status).toBe(409);
  });

  it("invitations: role-limited, single use, creates the account", async () => {
    const t = await createTenant();
    const gm = await addMember(t, "general_manager");
    const gmCookie = await loginAs(gm.email, PASSWORD, "10.7.0.1");
    const ownerCookie = await loginAs(t.ownerEmail, PASSWORD, "10.7.0.2");
    // a GM cannot mint an owner
    const bad = await api.v1("POST", "/team/invitations", { cookie: gmCookie, body: { email: "x@y.dev", role: "owner" } });
    expect(bad.status).toBe(403);
    const inv = await api.v1("POST", "/team/invitations", { cookie: ownerCookie, body: { email: `host-${randomUUID().slice(0, 5)}@y.dev`, role: "host" } });
    expect(inv.status).toBe(201);
    const token = new URL(inv.json.devLink).searchParams.get("token")!;
    const info = await api.auth("GET", `/invitation?token=${token}`);
    expect(info.json.role).toBe("host");
    const acc = await api.auth("POST", "/accept-invitation", { body: { token, name: "New Host", password: "Host-Pass-12345" }, ip: "10.7.0.3" });
    expect(acc.status).toBe(200);
    const cookie = acc.headers.get("set-cookie")!.split(";")[0];
    expect((await api.auth("GET", "/me", { cookie })).json.role).toBe("host");
    expect((await api.auth("POST", "/accept-invitation", { body: { token, name: "Again", password: "Host-Pass-12345" }, ip: "10.7.0.4" })).status).toBe(404);
  });

  it("suspended organizations are locked out while their data stays intact", async () => {
    const t = await createTenant();
    const cookie = await loginAs(t.ownerEmail, PASSWORD, "10.8.0.1");
    await withSystem((db) => db.exec(`UPDATE organizations SET status='suspended' WHERE id=$1`, [t.orgId]));
    const r = await api.v1("GET", `/reservations?locationId=${t.locationId}`, { cookie });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("ORG_SUSPENDED");
    const pub = await api.pub("GET", `/restaurants/${t.slug}`);
    expect(pub.status).toBe(404);
    const rows = await withSystem((db) => db.one<{ n: number }>(`SELECT count(*)::int n FROM tables WHERE org_id=$1`, [t.orgId]));
    expect(rows.n).toBe(3);
  });
});
