import { describe, expect, it } from "vitest";
import { api, loginAs } from "./api";
import { addMember, booking, createTenant, futureDate } from "./helpers";
import { createReservation } from "@/server/reservations/service";
import type { Role } from "@/lib/rbac";
import { ROLES } from "@/lib/rbac";

type Probe = { name: string; method: string; path: (t: ReturnType<typeof ctx>) => string; body?: (t: ReturnType<typeof ctx>) => unknown; allow: Role[] };
const ctx = (t: { locationId: string; resId: string; tableId: string }) => t;
const ALL = [...ROLES];

const PROBES: Probe[] = [
  { name: "view reservations", method: "GET", path: (t) => `/reservations?locationId=${t.locationId}`, allow: ["owner", "general_manager", "restaurant_manager", "host", "service"] },
  { name: "create reservation", method: "POST", path: () => `/reservations`, body: (t) => ({ locationId: t.locationId, date: futureDate(20), time: "13:00", partySize: 2, guestName: "Probe", guestPhone: "+212600001111" }), allow: ["owner", "general_manager", "restaurant_manager", "host"] },
  { name: "reservation transition", method: "POST", path: (t) => `/reservations/${t.resId}/transition`, body: () => ({ action: "arrive" }), allow: ["owner", "general_manager", "restaurant_manager", "host"] },
  { name: "floor view", method: "GET", path: (t) => `/floor/state?locationId=${t.locationId}`, allow: ["owner", "general_manager", "restaurant_manager", "host", "service"] },
  { name: "mark table ready", method: "POST", path: (t) => `/floor/tables/${t.tableId}/status`, body: () => ({ status: "available" }), allow: ["owner", "general_manager", "restaurant_manager", "host", "service"] },
  { name: "edit floor plan", method: "PATCH", path: (t) => `/floor/tables/${t.tableId}`, body: () => ({ name: "Renamed" }), allow: ["owner", "general_manager", "restaurant_manager"] },
  { name: "waitlist", method: "GET", path: (t) => `/waitlist?locationId=${t.locationId}`, allow: ["owner", "general_manager", "restaurant_manager", "host"] },
  { name: "customers list", method: "GET", path: () => `/customers`, allow: ["owner", "general_manager", "restaurant_manager", "host", "service", "marketing_manager"] },
  { name: "customers merge", method: "POST", path: () => `/customers/merge`, body: () => ({ sourceId: "00000000-0000-0000-0000-000000000001", targetId: "00000000-0000-0000-0000-000000000002" }), allow: ["owner", "general_manager", "restaurant_manager"] },
  { name: "customers csv export", method: "GET", path: () => `/customers/export.csv`, allow: ["owner", "general_manager", "restaurant_manager", "marketing_manager"] },
  { name: "dashboard", method: "GET", path: () => `/dashboard`, allow: ALL },
  { name: "analytics", method: "GET", path: (t) => `/analytics?from=${futureDate(-3)}&to=${futureDate(0)}&locationId=${t.locationId}`, allow: ["owner", "general_manager", "restaurant_manager", "marketing_manager"] },
  { name: "marketing", method: "GET", path: () => `/marketing/campaigns`, allow: ["owner", "general_manager", "marketing_manager"] },
  { name: "automations", method: "GET", path: () => `/automations`, allow: ["owner", "general_manager", "marketing_manager"] },
  { name: "settings read", method: "GET", path: (t) => `/locations/${t.locationId}`, allow: ["owner", "general_manager", "restaurant_manager"] },
  { name: "settings write", method: "PATCH", path: (t) => `/locations/${t.locationId}`, body: () => ({ minNoticeMin: 30 }), allow: ["owner", "general_manager", "restaurant_manager"] },
  { name: "create location", method: "POST", path: () => `/locations`, body: () => ({ name: "Another Place" }), allow: ["owner", "general_manager"] },
  { name: "team", method: "GET", path: () => `/team`, allow: ["owner", "general_manager"] },
  { name: "audit log", method: "GET", path: () => `/audit`, allow: ["owner", "general_manager", "restaurant_manager"] },
  { name: "billing", method: "GET", path: () => `/billing`, allow: ["owner"] },
  { name: "integrations", method: "GET", path: () => `/integrations`, allow: ["owner", "general_manager"] },
];

describe("role-based access control (server enforced)", () => {
  it("every role can reach exactly its permitted endpoints", async () => {
    const t = await createTenant();
    const res = await createReservation(t.owner, booking(t, { date: futureDate(2) }));
    const probeCtx = ctx({ locationId: t.locationId, resId: res.id, tableId: t.tableIds[0] });
    const cookies: Partial<Record<Role, string>> = { owner: await loginAs(t.ownerEmail, undefined, "10.20.0.1") };
    let i = 2;
    for (const role of ROLES.filter((r) => r !== "owner")) cookies[role] = await loginAs((await addMember(t, role)).email, undefined, `10.20.0.${i++}`);
    const failures: string[] = [];
    for (const p of PROBES) {
      for (const role of ROLES) {
        const r = await api.v1(p.method, p.path(probeCtx), { cookie: cookies[role], body: p.body?.(probeCtx) });
        const allowed = p.allow.includes(role);
        const denied = r.status === 403;
        if (allowed && denied) failures.push(`${role} should be ALLOWED to ${p.name} (got ${r.status} ${r.json?.error?.code})`);
        if (!allowed && !denied) failures.push(`${role} should be DENIED ${p.name} (got ${r.status})`);
        if (r.status === 401 || r.status >= 500) failures.push(`${role} ${p.name} unexpected ${r.status} ${r.text.slice(0, 120)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("super-admin endpoints reject every tenant role, including owners", async () => {
    const t = await createTenant();
    const cookie = await loginAs(t.ownerEmail, undefined, "10.21.0.1");
    for (const path of ["/overview", "/organizations", "/audit", "/plans"]) expect((await api.admin("GET", path, { cookie })).status).toBe(403);
    expect((await api.admin("GET", "/overview")).status).toBe(401);
    expect((await api.admin("POST", `/organizations/${t.orgId}/suspend`, { cookie, body: { reason: "nope" } })).status).toBe(403);
  });

  it("a member cannot escalate: GM cannot modify owners, nobody can demote the last owner", async () => {
    const t = await createTenant();
    const gm = await addMember(t, "general_manager");
    const gmCookie = await loginAs(gm.email, undefined, "10.22.0.1");
    const ownerCookie = await loginAs(t.ownerEmail, undefined, "10.22.0.2");
    const team = await api.v1("GET", "/team", { cookie: ownerCookie });
    const ownerMember = team.json.members.find((m: { role: string }) => m.role === "owner");
    expect((await api.v1("PATCH", `/team/members/${ownerMember.id}`, { cookie: gmCookie, body: { role: "host" } })).status).toBe(403);
    expect((await api.v1("DELETE", `/team/members/${ownerMember.id}`, { cookie: gmCookie })).status).toBe(403);
    expect((await api.v1("PATCH", `/team/members/${ownerMember.id}`, { cookie: ownerCookie, body: { role: "host" } })).status).toBe(403); // self
    const gmMember = team.json.members.find((m: { email: string }) => m.email === gm.email);
    expect((await api.v1("PATCH", `/team/members/${gmMember.id}`, { cookie: gmCookie, body: { role: "owner" } })).status).toBe(403);
  });
});
