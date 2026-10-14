import { randomUUID } from "node:crypto";
import { withSystem } from "@/lib/db";
import { hashPassword, type Ctx } from "@/lib/auth";
import type { Role } from "@/lib/rbac";
import { DateTime } from "luxon";
import { addDays } from "@/lib/time";
import { seedDefaultAutomations } from "@/server/automation/service";

export interface Tenant {
  orgId: string; locationId: string; floorId: string; slug: string; tableIds: string[]; tables: Record<string, string>;
  owner: Ctx; ownerEmail: string; tz: string;
}

export const PASSWORD = "Test-Passw0rd!";

export async function createTenant(o: { tables?: Array<{ name: string; capacity: number; min?: number; online?: boolean }>; plan?: string; locationPatch?: string; status?: string } = {}): Promise<Tenant> {
  const id = randomUUID().slice(0, 8);
  const tables = o.tables ?? [{ name: "T1", capacity: 2 }, { name: "T2", capacity: 4 }, { name: "T3", capacity: 6 }];
  const ownerEmail = `owner-${id}@test.dev`;
  const hash = await hashPassword(PASSWORD);
  return withSystem(async (db) => {
    const org = await db.one<{ id: string }>(`INSERT INTO organizations (name, slug, plan_id, status) VALUES ($1,$2,$3,$4) RETURNING id`, [`Org ${id}`, `org-${id}`, o.plan ?? "enterprise", o.status ?? "active"]);
    const user = await db.one<{ id: string }>(`INSERT INTO users (email, password_hash, name) VALUES ($1,$2,'Owner') RETURNING id`, [ownerEmail, hash]);
    await db.exec(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'owner')`, [org.id, user.id]);
    const loc = await db.one<{ id: string }>(`INSERT INTO locations (org_id, name, slug, timezone, min_notice_min, buffer_min) VALUES ($1,$2,$3,'Africa/Casablanca',0,10) RETURNING id`, [org.id, `Resto ${id}`, `resto-${id}`]);
    await db.exec(`INSERT INTO services (org_id, location_id, name, days, start_time, last_seating) VALUES ($1,$2,'All day','{1,2,3,4,5,6,7}','10:00','22:00')`, [org.id, loc.id]);
    const floor = await db.one<{ id: string }>(`INSERT INTO floors (org_id, location_id, name) VALUES ($1,$2,'Main') RETURNING id`, [org.id, loc.id]);
    const tableIds: string[] = []; const named: Record<string, string> = {};
    for (const t of o.tables ?? tables) {
      const r = await db.one<{ id: string }>(`INSERT INTO tables (org_id, location_id, floor_id, name, min_capacity, capacity, bookable_online) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [org.id, loc.id, floor.id, t.name, t.min ?? 1, t.capacity, t.online ?? true]);
      tableIds.push(r.id); named[t.name] = r.id;
    }
    await seedDefaultAutomations(db, org.id);
    const owner: Ctx = {
      user: { id: user.id, email: ownerEmail, name: "Owner", locale: "fr", isSuperAdmin: false }, orgId: org.id, role: "owner", locationIds: null,
      org: { id: org.id, name: `Org ${id}`, planId: o.plan ?? "enterprise", status: o.status ?? "active" }, sessionHash: "test",
    };
    return { orgId: org.id, locationId: loc.id, floorId: floor.id, slug: `resto-${id}`, tableIds, tables: named, owner, ownerEmail, tz: "Africa/Casablanca" };
  });
}

export async function addMember(t: Tenant, role: Role, locationIds: string[] | null = null): Promise<Ctx & { email: string }> {
  const id = randomUUID().slice(0, 8);
  const email = `${role}-${id}@test.dev`;
  const hash = await hashPassword(PASSWORD);
  return withSystem(async (db) => {
    const user = await db.one<{ id: string }>(`INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id`, [email, hash, role]);
    await db.exec(`INSERT INTO memberships (org_id, user_id, role, location_ids) VALUES ($1,$2,$3,$4)`, [t.orgId, user.id, role, locationIds]);
    return { ...t.owner, user: { id: user.id, email, name: role, locale: "fr", isSuperAdmin: false }, role, locationIds, email };
  });
}

/** Test helper: calendar date `days` from now. Uses UTC+1 wall clock; tests avoid asserting on the current day boundary. */
export const futureDate = (days = 3, tz = "Africa/Casablanca") => addDays(DateTime.now().setZone(tz).toISODate()!, days);

export function booking(t: Tenant, over: Record<string, unknown> = {}) {
  const n = randomUUID().slice(0, 6);
  return {
    locationId: t.locationId, date: futureDate(3), time: "19:00", partySize: 2, guestName: `Guest ${n}`,
    guestPhone: `+2126${Math.floor(10000000 + Math.random() * 89999999)}`, source: "staff" as const, ...over,
  } as never;
}
