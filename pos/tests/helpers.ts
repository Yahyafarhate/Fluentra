import { randomUUID } from "node:crypto";
import { withSystem } from "@/lib/db";
import { getCtx } from "@/lib/auth";
import { createOrganization } from "@/server/setup/service";
import { createRoom, createTable } from "@/server/outlets/service";
import { pinLogin, passwordLogin, hashSecret, type Ctx } from "@/lib/auth";
import type { Role } from "@/lib/rbac";
import { call as callRouter, type Res } from "./api";
import { authRouter } from "@/server/routes/auth";
import { v1 } from "@/server/routes/v1";
import { sha256 } from "@/lib/ids";

export const PASSWORD = "Test-Passw0rd!";
export const OWNER_PIN = "4826";

export interface Tenant {
  orgId: string; outletId: string; code: string; ownerEmail: string; ownerId: string;
  roomId: string; tables: Record<string, string>; stations: Record<string, string>;
  taxIds: Record<number, string>;
  cookie: string; owner: Ctx;
}

/** Signs in through the real login route and returns the Cookie header value. */
export async function cookieFor(res: Res): Promise<string> {
  const set = res.headers.get("set-cookie");
  if (!set) throw new Error("no session cookie: " + res.text);
  return set.split(";")[0];
}

let ipCounter = 10;
const nextIp = () => `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

export async function createTenant(o: { tables?: Array<{ label: string; seats: number }> } = {}): Promise<Tenant> {
  const id = randomUUID().slice(0, 8);
  const email = `owner-${id}@test.dev`;
  const r = await createOrganization({ organizationName: `Org ${id}`, outletName: `Resto ${id}`, ownerName: "Owner", email, password: PASSWORD, pin: OWNER_PIN, currency: "MAD", timezone: "Africa/Casablanca", locale: "fr" });
  const login = await callRouter(authRouter, "POST", "/api/auth/login", { body: { email, password: PASSWORD }, ip: nextIp() });
  const cookie = await cookieFor(login);
  const owner = (await getCtx(cookie.split("=")[1]))!;
  const roomId = await withSystem(async (db) => (await db.one<{ id: string }>(`SELECT id FROM dining_rooms WHERE outlet_id = $1`, [r.outletId])).id);
  const tables: Record<string, string> = {};
  await withSystem(async (db) => {
    const ctx = owner;
    for (const t of o.tables ?? [{ label: "T1", seats: 2 }, { label: "T2", seats: 4 }, { label: "T3", seats: 6 }]) tables[t.label] = (await createTable(db, ctx, roomId, { label: t.label, seats: t.seats, x: 0, y: 0, w: 90, h: 90, shape: "square" })).id;
  });
  const stations: Record<string, string> = {};
  const st = await withSystem((db) => db.query<{ id: string; kind: string }>(`SELECT id, kind FROM stations WHERE outlet_id = $1`, [r.outletId]));
  for (const s of st) stations[s.kind] = s.id;
  const taxIds: Record<number, string> = {};
  for (const t of await withSystem((db) => db.query<{ id: string; rateBps: number }>(`SELECT id, rate_bps FROM tax_rates WHERE org_id = $1`, [r.orgId]))) taxIds[t.rateBps] = t.id;
  void createRoom; void pinLogin; void passwordLogin; void hashSecret; void sha256;
  return { orgId: r.orgId, outletId: r.outletId, code: r.terminalCode, ownerEmail: email, ownerId: r.ownerId, roomId, tables, stations, taxIds, cookie, owner };
}

export async function addEmployee(t: Tenant, role: Role, o: { pin?: string; outletIds?: string[] | null } = {}): Promise<{ id: string; pin: string; name: string; cookie: string; ctx: Ctx }> {
  const pin = o.pin ?? String(Math.floor(2000 + Math.random() * 7000)).replace(/(\d)\1\1\1/, "2468");
  const name = `${role}-${randomUUID().slice(0, 5)}`;
  const res = await api.v1("POST", "/employees", { cookie: t.cookie, body: { name, role, pin, outletIds: o.outletIds ?? null } });
  if (res.status !== 201) throw new Error("create employee failed " + res.text);
  const id = res.json.id as string;
  const login = await callRouter(authRouter, "POST", "/api/auth/pin-login", { body: { outletCode: t.code, employeeId: id, pin }, ip: nextIp() });
  const cookie = await cookieFor(login);
  return { id, pin, name, cookie, ctx: (await getCtx(cookie.split("=")[1]))! };
}

export const api = {
  v1: (m: string, p: string, o?: Parameters<typeof callRouter>[3]) => callRouter(v1, m, "/api/v1" + p, o),
  auth: (m: string, p: string, o?: Parameters<typeof callRouter>[3]) => callRouter(authRouter, m, "/api/auth" + p, o),
};
export { nextIp };

/** A small menu: soup (kitchen), burger with modifier groups (kitchen), tea (bar), cake (pastry) and a 20% beer. */
export async function seedMenu(t: Tenant) {
  const c = t.cookie;
  const cat = await api.v1("POST", "/menu/categories", { cookie: c, body: { name: "Food" } });
  const drinks = await api.v1("POST", "/menu/categories", { cookie: c, body: { name: "Drinks" } });
  const sizes = await api.v1("POST", "/menu/modifier-groups", { cookie: c, body: { name: "Cooking", minSelect: 1, maxSelect: 1, modifiers: [{ name: "Medium", priceDeltaCents: 0 }, { name: "Well done", priceDeltaCents: 0 }] } });
  const extras = await api.v1("POST", "/menu/modifier-groups", { cookie: c, body: { name: "Extras", minSelect: 0, maxSelect: 2, modifiers: [{ name: "Cheese", priceDeltaCents: 1000 }, { name: "Bacon", priceDeltaCents: 1500 }] } });
  const mk = async (name: string, priceCents: number, o: Record<string, unknown> = {}) => {
    const r = await api.v1("POST", "/menu/products", { cookie: c, body: { name, priceCents, taxRateId: t.taxIds[1000], categoryId: cat.json.id, stationKind: "kitchen", ...o } });
    if (r.status !== 201) throw new Error("product failed " + r.text);
    return r.json.id as string;
  };
  const menuMods = (await api.v1("GET", "/menu/modifier-groups", { cookie: c })).json as Array<{ id: string; name: string; modifiers: Array<{ id: string; name: string }> }>;
  const cooking = menuMods.find((g) => g.name === "Cooking")!; const ext = menuMods.find((g) => g.name === "Extras")!;
  void sizes; void extras;
  const soup = await mk("Harira soup", 4000);
  const burger = await mk("Burger", 9000, { modifierGroupIds: [cooking.id, ext.id] });
  const tea = await mk("Mint tea", 2500, { stationKind: "bar", categoryId: drinks.json.id });
  const cake = await mk("Chocolate cake", 5000, { stationKind: "pastry", defaultCourse: 3 });
  const beer = await mk("Beer", 5000, { stationKind: "bar", taxRateId: t.taxIds[2000], categoryId: drinks.json.id });
  return { soup, burger, tea, cake, beer, cooking, extras: ext, cat: cat.json.id as string };
}

export async function openCashDrawer(t: Tenant, cookie = t.cookie, floatCents = 50000) {
  const r = await api.v1("POST", "/cash/sessions", { cookie, body: { outletId: t.outletId, openingFloatCents: floatCents } });
  if (r.status !== 201) throw new Error("cash open failed " + r.text);
  return r.json as { id: string };
}

export async function openOrder(t: Tenant, tableLabel = "T1", covers = 2, cookie = t.cookie) {
  const r = await api.v1("POST", "/orders", { cookie, body: { outletId: t.outletId, tableId: t.tables[tableLabel], covers } });
  if (r.status !== 201) throw new Error("open order failed " + r.text);
  return r.json.order.id as string;
}
export const addItem = (orderId: string, cookie: string, productId: string, extra: Record<string, unknown> = {}) =>
  api.v1("POST", `/orders/${orderId}/items`, { cookie, body: { items: [{ productId, qty: 1, ...extra }] } });

let payN = 0;
export const payBody = (o: Record<string, unknown>) => ({ idempotencyKey: `test-pay-${Date.now()}-${payN++}`, ...o });
