import { describe, it, expect } from "vitest";
import { api, createTenant, seedMenu, openCashDrawer, openOrder, addItem, addEmployee, payBody, type Tenant } from "./helpers";

type Item = { id: string; name: string; status: string; qty: number; unitPriceCents: number; course: number };
const itemOf = (view: { items: Item[] }, name: string) => view.items.find((i) => i.name === name)!;

describe("end-to-end service: floor → order → kitchen → bill → payment → reports", () => {
  it("runs a complete dine-in service with split bill and reconciled reports", async () => {
    const t = await createTenant();
    const m = await seedMenu(t);
    const c = t.cookie;
    await openCashDrawer(t);

    // 1-2. open the table with covers; covers are mandatory for dine-in
    const bad = await api.v1("POST", "/orders", { cookie: c, body: { outletId: t.outletId, tableId: t.tables.T1 } });
    expect(bad.status).toBe(400); expect(bad.json.error.code).toBe("COVERS_REQUIRED");
    const orderId = await openOrder(t, "T1", 2);

    // 3. modifiers: a required group must be chosen, group limits are enforced
    const noMod = await addItem(orderId, c, m.burger);
    expect(noMod.status).toBe(400); expect(noMod.json.error.code).toBe("MODIFIER_REQUIRED");
    const tooMany = await addItem(orderId, c, m.burger, { modifierIds: [m.cooking.modifiers[0].id, ...m.extras.modifiers.map((x: { id: string }) => x.id), m.extras.modifiers[0].id] });
    expect(tooMany.status).toBe(400);
    const cheese = m.extras.modifiers.find((x: { name: string }) => x.name === "Cheese")!.id;
    const burgerRes = await addItem(orderId, c, m.burger, { modifierIds: [m.cooking.modifiers[0].id, cheese], note: "no onions", allergyNote: "NUT ALLERGY", seat: 1 });
    expect(burgerRes.status).toBe(200);
    expect(itemOf(burgerRes.json, "Burger").unitPriceCents).toBe(10000);
    await addItem(orderId, c, m.soup, { seat: 2 });
    await addItem(orderId, c, m.tea);
    const withCake = await addItem(orderId, c, m.cake);   // default course 3
    expect(itemOf(withCake.json, "Chocolate cake").course).toBe(3);
    expect(withCake.json.totals.totalCents).toBe(21500);

    // floor state: occupied (draft items only)
    let floor = await api.v1("GET", `/outlets/${t.outletId}/floor`, { cookie: c });
    expect(floor.json.tables.find((x: { label: string }) => x.label === "T1").status).toBe("occupied");

    // 4. send: course 1 fires, course 3 is held
    const sent = await api.v1("POST", `/orders/${orderId}/send`, { cookie: c });
    expect(sent.status).toBe(200);
    expect(itemOf(sent.json, "Burger").status).toBe("fired");
    expect(itemOf(sent.json, "Mint tea").status).toBe("fired");
    expect(itemOf(sent.json, "Chocolate cake").status).toBe("held");
    expect((await api.v1("POST", `/orders/${orderId}/send`, { cookie: c })).json.error.code).toBe("NOTHING_TO_SEND");
    floor = await api.v1("GET", `/outlets/${t.outletId}/floor`, { cookie: c });
    expect(floor.json.tables.find((x: { label: string }) => x.label === "T1").status).toBe("ordered");

    // routing: kitchen sees burger + soup (with allergy), bar sees tea, pastry sees nothing yet
    const kitchen = await api.v1("GET", `/stations/${t.stations.kitchen}/board`, { cookie: c });
    expect(kitchen.json.tickets).toHaveLength(1);
    const ticket = kitchen.json.tickets[0];
    expect(ticket.items.map((i: { name: string }) => i.name).sort()).toEqual(["Burger", "Harira soup"]);
    expect(ticket.hasAllergy).toBe(true); expect(ticket.tableLabel).toBe("T1");
    expect(ticket.items.find((i: { name: string }) => i.name === "Burger").modifiers).toEqual(expect.arrayContaining(["Medium", "Cheese"]));
    expect((await api.v1("GET", `/stations/${t.stations.bar}/board`, { cookie: c })).json.tickets[0].items.map((i: { name: string }) => i.name)).toEqual(["Mint tea"]);
    expect((await api.v1("GET", `/stations/${t.stations.pastry}/board`, { cookie: c })).json.tickets).toHaveLength(0);

    // 5. kitchen statuses flow back to the POS
    const burgerId = itemOf(sent.json, "Burger").id; const soupId = itemOf(sent.json, "Harira soup").id;
    const act = (station: string, body: unknown) => api.v1("POST", `/stations/${station}/action`, { cookie: c, body });
    expect((await act(t.stations.kitchen, { action: "ready", itemIds: [burgerId] })).status).toBe(200);          // fast path: fired → ready
    expect((await act(t.stations.kitchen, { action: "accept", itemIds: [burgerId] })).json.error.code).toBe("INVALID_TRANSITION");
    expect((await act(t.stations.kitchen, { action: "start", orderId })).status).toBe(200);                      // ticket-level start: only soup is eligible
    let view = (await api.v1("GET", `/orders/${orderId}`, { cookie: c })).json;
    expect(itemOf(view, "Burger").status).toBe("ready"); expect(itemOf(view, "Harira soup").status).toBe("preparing");
    expect((await act(t.stations.kitchen, { action: "recall", itemIds: [burgerId] })).status).toBe(200);
    expect(itemOf((await api.v1("GET", `/orders/${orderId}`, { cookie: c })).json, "Burger").status).toBe("preparing");
    await act(t.stations.kitchen, { action: "ready", orderId });
    await act(t.stations.bar, { action: "ready", orderId });
    view = (await api.v1("POST", `/orders/${orderId}/serve`, { cookie: c, body: {} })).json;
    expect(view.items.filter((i: Item) => i.status === "served")).toHaveLength(3);

    // 6. fire the dessert course, then split the bill by item and transfer the table
    expect((await api.v1("POST", `/orders/${orderId}/fire`, { cookie: c, body: { course: 3 } })).status).toBe(200);
    const split = await api.v1("POST", `/orders/${orderId}/move-items`, { cookie: c, body: { itemIds: [burgerId] } });
    expect(split.status).toBe(200);
    const check2 = split.json.to.order.id as string;
    expect(split.json.to.totals.totalCents).toBe(10000); expect(split.json.from.totals.totalCents).toBe(11500);
    const moved = await api.v1("POST", `/orders/${orderId}/transfer`, { cookie: c, body: { tableId: t.tables.T2 } });
    expect(moved.status).toBe(200); expect(moved.json.order.tableLabel).toBe("T2");
    floor = await api.v1("GET", `/outlets/${t.outletId}/floor`, { cookie: c });
    expect(floor.json.tables.find((x: { label: string }) => x.label === "T1").status).toBe("available");

    // 7. payments: cash with tip and change on the first check; the card is declined, then approved, on the second
    expect((await api.v1("POST", `/orders/${orderId}/bill-request`, { cookie: c })).status).toBe(200);
    floor = await api.v1("GET", `/outlets/${t.outletId}/floor`, { cookie: c });
    expect(floor.json.tables.find((x: { label: string }) => x.label === "T2").status).toBe("ordered");       // the other check has not asked for its bill yet
    expect((await api.v1("POST", `/orders/${check2}/bill-request`, { cookie: c })).status).toBe(200);
    floor = await api.v1("GET", `/outlets/${t.outletId}/floor`, { cookie: c });
    expect(floor.json.tables.find((x: { label: string }) => x.label === "T2").status).toBe("awaiting_payment");
    const over = await api.v1("POST", `/orders/${orderId}/payments`, { cookie: c, body: payBody({ method: "cash", amountCents: 20000 }) });
    expect(over.status).toBe(409); expect(over.json.error.code).toBe("OVERPAYMENT");
    const cash = await api.v1("POST", `/orders/${orderId}/payments`, { cookie: c, body: payBody({ method: "cash", amountCents: 11500, tipCents: 500, tenderedCents: 20000 }) });
    expect(cash.status).toBe(201); expect(cash.json.closed).toBe(true);
    expect(cash.json.payment.changeCents).toBe(8000);
    expect(cash.json.order.order.status).toBe("closed"); expect(cash.json.order.totals.totalCents).toBe(11500);

    const declined = await api.v1("POST", `/orders/${check2}/payments`, { cookie: c, body: payBody({ method: "card", amountCents: 10000, testScenario: "decline" }) });
    expect(declined.status).toBe(402); expect(declined.json.payment.status).toBe("declined");
    expect(declined.json.order.order.status).toBe("open"); expect(declined.json.order.dueCents).toBe(10000);
    const approved = await api.v1("POST", `/orders/${check2}/payments`, { cookie: c, body: payBody({ method: "card", amountCents: 10000 }) });
    expect(approved.status).toBe(201); expect(approved.json.closed).toBe(true); expect(approved.json.payment.provider).toBe("test_terminal");

    // closed orders are immutable and the kitchen may still finish after payment
    expect((await addItem(orderId, c, m.soup)).json.error.code).toBe("ORDER_CLOSED");
    expect((await act(t.stations.pastry, { action: "ready", orderId })).status).toBe(200);

    // 8-10. reports reconcile with the transactions
    const bd = approved.json.order.order.businessDate as string;
    const q = `from=${bd}&to=${bd}&outletId=${t.outletId}`;
    const sum = (await api.v1("GET", `/reports/summary?${q}`, { cookie: c })).json.current;
    expect(sum.orders).toBe(2); expect(sum.covers).toBe(2); expect(sum.totalCents).toBe(21500); expect(sum.tipsCents).toBe(500);
    expect(sum.taxCents).toBe(1954); expect(sum.netSalesCents).toBe(19546); expect(sum.grossCents).toBe(21500); expect(sum.avgPerCoverCents).toBe(10750);
    const methods = (await api.v1("GET", `/reports/payment-methods?${q}`, { cookie: c })).json as Array<{ method: string; amountCents: number; tipsCents: number }>;
    expect(methods.find((x) => x.method === "cash")).toMatchObject({ amountCents: 11500, tipsCents: 500 });
    expect(methods.find((x) => x.method === "card")).toMatchObject({ amountCents: 10000 });
    const rec = (await api.v1("GET", `/reports/reconcile?${q}`, { cookie: c })).json;
    expect(rec.ok).toBe(true); expect(rec.billedCents).toBe(rec.paidCents); expect(rec.declinedPayments).toBe(1); expect(rec.mismatches).toHaveLength(0);
    const products = (await api.v1("GET", `/reports/by-product?${q}`, { cookie: c })).json as Array<{ name: string; qty: number; grossCents: number }>;
    expect(products.reduce((s, p) => s + p.grossCents, 0)).toBe(sum.grossCents);
    expect(products.find((p) => p.name === "Burger")).toMatchObject({ qty: 1, grossCents: 10000 });
    const drill = (await api.v1("GET", `/reports/orders?${q}&method=card`, { cookie: c })).json as Array<{ id: string }>;
    expect(drill.map((o) => o.id)).toEqual([check2]);
    const byHour = (await api.v1("GET", `/reports/by-hour?${q}`, { cookie: c })).json as Array<{ totalCents: number }>;
    expect(byHour.reduce((s, h) => s + h.totalCents, 0)).toBe(21500);
    const csv = await api.v1("GET", `/reports/export?${q}&kind=products`, { cookie: c });
    expect(csv.headers.get("content-type")).toContain("text/csv"); expect(csv.text).toContain("Burger");

    // the audit trail tells the story of the order
    const audit = (await api.v1("GET", `/audit?orderId=${orderId}`, { cookie: c })).json as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["order.open", "order.add_items", "order.send", "order.fire_course", "order.split", "order.transfer_table", "payment.succeeded", "order.close"]));
  });

  it("walk-in / takeaway / room-service orders need no table and honour order types", async () => {
    const t = await createTenant(); const m = await seedMenu(t);
    const r = await api.v1("POST", "/orders", { cookie: t.cookie, body: { outletId: t.outletId, type: "room_service", roomRef: "Room 204" } });
    expect(r.status).toBe(201); expect(r.json.order.type).toBe("room_service"); expect(r.json.order.roomRef).toBe("Room 204");
    await addItem(r.json.order.id, t.cookie, m.tea);
    const floor = await api.v1("GET", `/outlets/${t.outletId}/floor`, { cookie: t.cookie });
    expect(floor.json.quickOrders).toHaveLength(1);
    const take = await api.v1("POST", "/orders", { cookie: t.cookie, body: { outletId: t.outletId, type: "takeaway" } });
    expect(take.json.order.orderNo).toBe(r.json.order.orderNo + 1);
  });
});
