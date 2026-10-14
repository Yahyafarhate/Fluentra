/** DEVELOPMENT SEED ONLY — never run against production data. Creates a demo organization with a menu, staff and a few closed orders. */
import { loadEnv } from "./load-env";
import { call } from "../tests/api";
import { authRouter } from "../src/server/routes/auth";
import { v1 } from "../src/server/routes/v1";
import { createOrganization } from "../src/server/setup/service";

export const DEMO_PASSWORD = "Demo-Pass-2026";
const STAFF = [
  { name: "Salma Chraibi", role: "manager", pin: "3579" }, { name: "Youssef Lahlou", role: "supervisor", pin: "4680" }, { name: "Nadia Berrada", role: "cashier", pin: "5791" },
  { name: "Omar Fassi", role: "server", pin: "6802" }, { name: "Imane Kettani", role: "bartender", pin: "7913" }, { name: "Chef Hamza", role: "kitchen", pin: "8024" },
];

export async function seed() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed a production database");
  const org = await createOrganization({ organizationName: "Atlas Hospitality (demo)", outletName: "Café Atlas", ownerName: "Karim Bennani", email: "owner@atlas.demo", password: DEMO_PASSWORD, pin: "2468", currency: "MAD", timezone: "Africa/Casablanca", locale: "fr" });
  const ip = "10.0.0.1";
  const login = await call(authRouter, "POST", "/api/auth/login", { body: { email: "owner@atlas.demo", password: DEMO_PASSWORD }, ip });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const V = async (m: string, p: string, body?: unknown) => { const r = await call(v1, m, "/api/v1" + p, { cookie, body }); if (r.status >= 400) throw new Error(`${m} ${p} -> ${r.status} ${r.text}`); return r.json; };

  await V("PATCH", `/outlets/${org.outletId}`, { serviceChargeBps: 0, address: "12 rue des Consuls, Rabat", phone: "+212 5 37 00 00 00", taxIdentifier: "ICE 000000000000000 (demo)", receiptFooter: "Merci de votre visite !", tableAlertMinutes: 90 });
  for (const s of STAFF) await V("POST", "/employees", { ...s });
  const layout = await V("GET", `/outlets/${org.outletId}/layout`);
  const room = layout.rooms[0].id as string;
  const terrace = (await V("POST", `/outlets/${org.outletId}/rooms`, { name: "Terrasse" })).id as string;
  const grid = (room: string, labels: string[], seats: number[], cols: number, shape: "square" | "round" = "square") => Promise.all(labels.map((label, i) => V("POST", `/rooms/${room}/tables`, { label, seats: seats[i % seats.length], x: 30 + (i % cols) * 130, y: 30 + Math.floor(i / cols) * 130, w: 100, h: 100, shape })));
  await grid(room, ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"], [2, 2, 4, 4, 4, 6, 6, 8], 4);
  await grid(terrace, ["P1", "P2", "P3", "P4"], [2, 2, 4, 4], 4, "round");

  const taxes = (await V("GET", "/menu/tax-rates")) as Array<{ id: string; rateBps: number }>;
  const vat10 = taxes.find((t) => t.rateBps === 1000)!.id, vat20 = taxes.find((t) => t.rateBps === 2000)!.id;
  const cat = async (name: string, sort: number) => (await V("POST", "/menu/categories", { name, sort })).id as string;
  const [starters, mains, desserts, drinks] = [await cat("Entrées", 1), await cat("Plats", 2), await cat("Desserts", 3), await cat("Boissons", 4)];
  const cooking = (await V("POST", "/menu/modifier-groups", { name: "Cuisson", minSelect: 1, maxSelect: 1, modifiers: [{ name: "Saignant" }, { name: "À point" }, { name: "Bien cuit" }] })).id as string;
  const sides = (await V("POST", "/menu/modifier-groups", { name: "Accompagnement", minSelect: 0, maxSelect: 2, modifiers: [{ name: "Frites", priceDeltaCents: 1500 }, { name: "Légumes grillés", priceDeltaCents: 1500 }, { name: "Riz", priceDeltaCents: 1000 }] })).id as string;
  const sugar = (await V("POST", "/menu/modifier-groups", { name: "Sucre", minSelect: 1, maxSelect: 1, modifiers: [{ name: "Normal" }, { name: "Peu sucré" }, { name: "Sans sucre" }] })).id as string;
  const P = (name: string, priceCents: number, o: Record<string, unknown>) => V("POST", "/menu/products", { name, priceCents, taxRateId: vat10, ...o });
  await P("Harira", 3500, { categoryId: starters, defaultCourse: 1, allergens: ["gluten"] });
  await P("Salade marocaine", 4000, { categoryId: starters, defaultCourse: 1 });
  await P("Pastilla au poulet", 7500, { categoryId: starters, defaultCourse: 1, allergens: ["gluten", "fruits à coque"] });
  await P("Tajine d'agneau", 14500, { categoryId: mains, defaultCourse: 2, allergens: ["fruits à coque"] });
  await P("Couscous royal", 16000, { categoryId: mains, defaultCourse: 2, allergens: ["gluten"] });
  await P("Entrecôte grillée", 18500, { categoryId: mains, defaultCourse: 2, modifierGroupIds: [cooking, sides] });
  await P("Burger Atlas", 12500, { categoryId: mains, defaultCourse: 2, modifierGroupIds: [cooking, sides], allergens: ["gluten", "lait"] });
  await P("Cornes de gazelle", 3500, { categoryId: desserts, stationKind: "pastry", defaultCourse: 3, allergens: ["fruits à coque", "gluten"] });
  await P("Fondant au chocolat", 6500, { categoryId: desserts, stationKind: "pastry", defaultCourse: 3, allergens: ["gluten", "lait", "œufs"] });
  await P("Thé à la menthe", 2500, { categoryId: drinks, stationKind: "bar", modifierGroupIds: [sugar] });
  await P("Café crème", 2200, { categoryId: drinks, stationKind: "bar" });
  await P("Jus d'orange pressé", 3000, { categoryId: drinks, stationKind: "bar" });
  await P("Eau minérale 50cl", 1500, { categoryId: drinks, stationKind: "bar" });
  await P("Bière locale", 5500, { categoryId: drinks, stationKind: "bar", taxRateId: vat20 });
  await V("POST", "/menu/discounts", { name: "Personnel 10%", kind: "percent", value: 1000, approvalThresholdBps: 1000 });
  await V("POST", "/menu/discounts", { name: "Fidélité 15%", kind: "percent", value: 1500, approvalThresholdBps: 1000 });
  await V("POST", "/menu/discounts", { name: "Geste commercial 50 MAD", kind: "amount", value: 5000, approvalThresholdBps: 1000 });

  // a few finished orders for the reports
  await V("POST", "/cash/sessions", { outletId: org.outletId, openingFloatCents: 100000 });
  const menu = (await V("GET", `/outlets/${org.outletId}/menu`)) as { products: Array<{ id: string; name: string; modifierGroups: Array<{ modifiers: Array<{ id: string }> }> }> };
  const prod = (n: string) => menu.products.find((p) => p.name === n)!;
  const tables = (await V("GET", `/outlets/${org.outletId}/layout`)).tables as Array<{ id: string; label: string }>;
  const tid = (l: string) => tables.find((t) => t.label === l)!.id;
  const tickets: Array<[string, number, string[], "cash" | "card"]> = [["T1", 2, ["Harira", "Tajine d'agneau", "Thé à la menthe"], "card"], ["T2", 4, ["Pastilla au poulet", "Couscous royal", "Fondant au chocolat", "Eau minérale 50cl"], "cash"], ["P1", 2, ["Burger Atlas", "Bière locale"], "card"]];
  const stations = (await V("GET", `/outlets/${org.outletId}/stations`)) as Array<{ id: string }>;
  let n = 0;
  for (const [table, covers, names, method] of tickets) {
    const o = await V("POST", "/orders", { outletId: org.outletId, tableId: tid(table), covers });
    const id = o.order.id as string;
    await V("POST", `/orders/${id}/items`, { items: names.map((nm) => ({ productId: prod(nm).id, qty: 1, modifierIds: prod(nm).modifierGroups.filter((g) => g.modifiers.length).map((g) => g.modifiers[0].id).slice(0, 1) })) });
    await V("POST", `/orders/${id}/send`);
    const view = await V("GET", `/orders/${id}`);
    await V("POST", `/orders/${id}/fire`, { course: 2 }).catch(() => undefined);
    await V("POST", `/orders/${id}/fire`, { course: 3 }).catch(() => undefined);
    const v2 = await V("GET", `/orders/${id}`);
    await V("POST", `/orders/${id}/payments`, { method, amountCents: v2.dueCents, tipCents: method === "card" ? 1000 : 0, idempotencyKey: `seed-${++n}-${Date.now()}` });
    // the kitchen finished these long ago: keep the KDS clean for the demo
    for (const st of stations) await V("POST", `/stations/${st.id}/action`, { action: "ready", orderId: id }).catch(() => undefined);
    await V("POST", `/orders/${id}/serve`, {}).catch(() => undefined);
    void view;
  }
  // two live tables so the floor is not empty
  for (const [table, covers, names] of [["T3", 3, ["Salade marocaine", "Entrecôte grillée"]], ["T6", 5, ["Harira", "Couscous royal"]]] as Array<[string, number, string[]]>) {
    const o = await V("POST", "/orders", { outletId: org.outletId, tableId: tid(table), covers });
    await V("POST", `/orders/${o.order.id}/items`, { items: names.map((nm) => ({ productId: prod(nm).id, qty: 1, modifierIds: prod(nm).modifierGroups.filter((g) => g.modifiers.length).map((g) => g.modifiers[0].id).slice(0, 1) })) });
    await V("POST", `/orders/${o.order.id}/send`);
  }

  console.log("\nDemo data created. Back office: owner@atlas.demo / " + DEMO_PASSWORD);
  console.log(`POS terminal code: ${org.terminalCode}`);
  console.log("PINs — owner 2468 · manager Salma 3579 · supervisor Youssef 4680 · cashier Nadia 5791 · server Omar 6802 · bartender Imane 7913 · kitchen Hamza 8024");
}

if (process.argv[1] && /seed\.(ts|js)$/.test(process.argv[1])) {
  loadEnv();
  seed().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
