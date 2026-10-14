import { describe, it, expect } from "vitest";
import { api, createTenant, seedMenu, openCashDrawer, openOrder, addItem, addEmployee, payBody, nextIp, type Tenant } from "./helpers";

type Item = { id: string; name: string; status: string };
const itemId = (v: { items: Item[] }, name: string) => v.items.find((i) => i.name === name)!.id;

async function paidOrder(t: Tenant, m: Awaited<ReturnType<typeof seedMenu>>, cookie = t.cookie, method: "cash" | "card" = "cash") {
  const id = await openOrder(t, "T1", 2, cookie);
  await addItem(id, cookie, m.soup);
  await api.v1("POST", `/orders/${id}/send`, { cookie });
  const p = await api.v1("POST", `/orders/${id}/payments`, { cookie, body: payBody({ method, amountCents: 4000 }) });
  expect(p.status).toBe(201);
  return { orderId: id, paymentId: p.json.payment.id as string, businessDate: p.json.order.order.businessDate as string };
}

describe("authorization, approvals and audited exceptions", () => {
  it("voiding a sent item needs a reason and a supervisor; wrong or self approvals are rejected; everything is audited", async () => {
    const t = await createTenant(); const m = await seedMenu(t);
    const server = await addEmployee(t, "server"); const sup = await addEmployee(t, "supervisor"); const cashier = await addEmployee(t, "cashier");
    const id = await openOrder(t, "T1", 2, server.cookie);
    const v = (await addItem(id, server.cookie, m.soup)).json;
    // unsent items can be removed freely
    const draftId = itemId(v, "Harira soup");
    const sent = (await api.v1("POST", `/orders/${id}/send`, { cookie: server.cookie })).json;
    const sentId = itemId(sent, "Harira soup"); expect(sentId).toBe(draftId);
    const url = `/orders/${id}/items/${sentId}/void`;
    expect((await api.v1("POST", url, { cookie: server.cookie, body: { reason: "x" } })).status).toBe(422);            // reason too short
    const noApproval = await api.v1("POST", url, { cookie: server.cookie, body: { reason: "Guest changed mind" } });
    expect(noApproval.status).toBe(403); expect(noApproval.json.error.code).toBe("APPROVAL_REQUIRED");
    const wrongPin = await api.v1("POST", url, { cookie: server.cookie, body: { reason: "Guest changed mind", approval: { employeeId: sup.id, pin: "9999" } } });
    expect(wrongPin.json.error.code).toBe("APPROVAL_DENIED");
    const notAllowed = await api.v1("POST", url, { cookie: server.cookie, body: { reason: "Guest changed mind", approval: { employeeId: cashier.id, pin: cashier.pin } } });
    expect(notAllowed.json.error.code).toBe("APPROVAL_DENIED");                                                           // a cashier cannot approve voids
    const selfApproval = await api.v1("POST", url, { cookie: sup.cookie, body: { reason: "Guest changed mind", approval: { employeeId: sup.id, pin: sup.pin } } });
    expect(selfApproval.status).toBe(200);                                                                                // a supervisor holds the authority themselves
    const ok = await api.v1("GET", `/orders/${id}`, { cookie: server.cookie });
    expect(ok.json.items.find((i: Item) => i.id === sentId).status).toBe("void");
    // second item: approved by supervisor PIN on a server's request
    await addItem(id, server.cookie, m.tea); await api.v1("POST", `/orders/${id}/send`, { cookie: server.cookie });
    const teaId = itemId((await api.v1("GET", `/orders/${id}`, { cookie: server.cookie })).json, "Mint tea");
    const approved = await api.v1("POST", `/orders/${id}/items/${teaId}/void`, { cookie: server.cookie, body: { reason: "Wrong table", approval: { employeeId: sup.id, pin: sup.pin } } });
    expect(approved.status).toBe(200);
    const audit = (await api.v1("GET", `/audit?orderId=${id}&action=order.void_item`, { cookie: t.cookie })).json as Array<{ approverId: string; metadata: { reason: string } }>;
    expect(audit).toHaveLength(2);
    expect(audit.some((a) => a.approverId === sup.id && a.metadata.reason === "Wrong table")).toBe(true);
    // voided sent items show on the kitchen screen as cancelled
    const board = (await api.v1("GET", `/stations/${t.stations.bar}/board`, { cookie: t.cookie })).json;
    expect(JSON.stringify(board)).not.toContain("Mint tea\",\"qty\":1,\"status\":\"fired\"");
  });

  it("discounts: small catalog discounts are free for servers, large/custom ones need a supervisor; amounts are audited", async () => {
    const t = await createTenant(); const m = await seedMenu(t);
    const server = await addEmployee(t, "server"); const sup = await addEmployee(t, "supervisor");
    const five = (await api.v1("POST", "/menu/discounts", { cookie: t.cookie, body: { name: "Staff 5%", kind: "percent", value: 500 } })).json.id;
    const thirty = (await api.v1("POST", "/menu/discounts", { cookie: t.cookie, body: { name: "VIP 30%", kind: "percent", value: 3000 } })).json.id;
    const id = await openOrder(t, "T1", 2, server.cookie);
    await addItem(id, server.cookie, m.burger, { modifierIds: [m.cooking.modifiers[0].id] });
    const url = `/orders/${id}/discounts`;
    const small = await api.v1("POST", url, { cookie: server.cookie, body: { discountId: five, reason: "Regular guest" } });
    expect(small.status).toBe(200); expect(small.json.totals.orderDiscountCents).toBe(450);
    expect((await api.v1("POST", url, { cookie: server.cookie, body: { discountId: thirty, reason: "VIP guest" } })).json.error.code).toBe("APPROVAL_REQUIRED");
    expect((await api.v1("POST", url, { cookie: server.cookie, body: { custom: { kind: "amount", value: 100 }, reason: "Spilled drink" } })).json.error.code).toBe("APPROVAL_REQUIRED");
    const big = await api.v1("POST", url, { cookie: server.cookie, body: { discountId: thirty, reason: "VIP guest", approval: { employeeId: sup.id, pin: sup.pin } } });
    expect(big.status).toBe(200);
    expect(big.json.totals.orderDiscountCents).toBe(450 + Math.round((9000 - 450) * 0.3));
    expect((await api.v1("POST", url, { cookie: server.cookie, body: { discountId: five, reason: "no" } })).status).toBe(422);   // reason mandatory
    const audit = (await api.v1("GET", `/audit?orderId=${id}&action=order.discount`, { cookie: t.cookie })).json as Array<{ approverId: string | null; metadata: { amountCents: number } }>;
    expect(audit.find((a) => a.approverId === sup.id)!.metadata.amountCents).toBe(Math.round((9000 - 450) * 0.3));
    // item-level discount
    const itemLevel = await api.v1("POST", url, { cookie: sup.cookie, body: { custom: { kind: "percent", value: 1000 }, itemId: (big.json.items as Item[])[0].id, reason: "Overcooked" } });
    expect(itemLevel.json.totals.itemDiscountCents).toBe(900);
  });

  it("refunds need a reason and an approver, cannot exceed the payment, and leave an audit trail and report entry", async () => {
    const t = await createTenant(); const m = await seedMenu(t);
    const cashier = await addEmployee(t, "cashier"); const mgr = await addEmployee(t, "manager"); const server = await addEmployee(t, "server");
    await openCashDrawer(t, cashier.cookie);
    const { paymentId, businessDate } = await paidOrder(t, m, cashier.cookie);
    const body = (o: Record<string, unknown>) => ({ amountCents: 1000, reason: "Soup was cold", idempotencyKey: `rf-${Math.random().toString(36).slice(2, 12)}`, ...o });
    expect((await api.v1("POST", `/payments/${paymentId}/refunds`, { cookie: server.cookie, body: body({}) })).status).toBe(403);   // servers cannot refund at all
    expect((await api.v1("POST", `/payments/${paymentId}/refunds`, { cookie: cashier.cookie, body: body({}) })).json.error.code).toBe("APPROVAL_REQUIRED");
    expect((await api.v1("POST", `/payments/${paymentId}/refunds`, { cookie: cashier.cookie, body: body({ reason: "x" }) })).status).toBe(422);
    const ok = await api.v1("POST", `/payments/${paymentId}/refunds`, { cookie: cashier.cookie, body: body({ approval: { employeeId: mgr.id, pin: mgr.pin } }) });
    expect(ok.status).toBe(201); expect(ok.json.status).toBe("succeeded");
    const tooMuch = await api.v1("POST", `/payments/${paymentId}/refunds`, { cookie: cashier.cookie, body: body({ amountCents: 3500, approval: { employeeId: mgr.id, pin: mgr.pin } }) });
    expect(tooMuch.status).toBe(409); expect(tooMuch.json.error.code).toBe("REFUND_EXCEEDS_PAYMENT");
    // idempotent replay
    const key = "rf-replay-12345678";
    const a = await api.v1("POST", `/payments/${paymentId}/refunds`, { cookie: cashier.cookie, body: body({ amountCents: 500, idempotencyKey: key, approval: { employeeId: mgr.id, pin: mgr.pin } }) });
    const b = await api.v1("POST", `/payments/${paymentId}/refunds`, { cookie: cashier.cookie, body: body({ amountCents: 500, idempotencyKey: key, approval: { employeeId: mgr.id, pin: mgr.pin } }) });
    expect(b.json.refundId).toBe(a.json.refundId);
    const q = `from=${businessDate}&to=${businessDate}&outletId=${t.outletId}`;
    const sum = (await api.v1("GET", `/reports/summary?${q}`, { cookie: t.cookie })).json.current;
    expect(sum.refunds).toEqual({ count: 2, amountCents: 1500 }); expect(sum.netOfRefundsCents).toBe(4000 - 1500);
    const dv = (await api.v1("GET", `/reports/discounts-voids?${q}`, { cookie: t.cookie })).json;
    expect(dv.refunds[0]).toMatchObject({ reason: "Soup was cold" }); expect(dv.refunds[0].approvedBy).toBe(mgr.name);
    // cash refund reduces the expected cash
    const drawer = (await api.v1("GET", `/outlets/${t.outletId}/cash`, { cookie: cashier.cookie })).json[0];
    expect(drawer.breakdown.cashRefundsCents).toBe(1500); expect(drawer.breakdown.expectedCents).toBe(50000 + 4000 - 1500);
  });

  it("reopening a closed order needs supervisor authority, is audited, and is blocked once the day is closed", async () => {
    const t = await createTenant(); const m = await seedMenu(t);
    const server = await addEmployee(t, "server"); const sup = await addEmployee(t, "supervisor");
    await openCashDrawer(t);
    const { orderId, businessDate } = await paidOrder(t, m);
    const url = `/orders/${orderId}/reopen`;
    expect((await api.v1("POST", url, { cookie: server.cookie, body: { reason: "Forgot a drink" } })).json.error.code).toBe("APPROVAL_REQUIRED");
    const re = await api.v1("POST", url, { cookie: server.cookie, body: { reason: "Forgot a drink", approval: { employeeId: sup.id, pin: sup.pin } } });
    expect(re.status).toBe(200); expect(re.json.order.status).toBe("open");
    expect(re.json.order.totalCents ?? null).toBeNull();
    // the old payment still counts; the new item raises the amount due
    await addItem(orderId, server.cookie, m.tea); await api.v1("POST", `/orders/${orderId}/send`, { cookie: server.cookie });
    const view = (await api.v1("GET", `/orders/${orderId}`, { cookie: server.cookie })).json;
    expect(view.dueCents).toBe(2500);
    const pay = await api.v1("POST", `/orders/${orderId}/payments`, { cookie: server.cookie, body: payBody({ method: "cash", amountCents: 2500 }) });
    expect(pay.json.closed).toBe(true); expect(pay.json.order.totals.totalCents).toBe(6500);
    // day close: blocked by an open cash session, then succeeds and freezes the day
    const open2 = await openOrder(t, "T2", 1);
    const block = await api.v1("POST", "/reports/day-close", { cookie: t.cookie, body: { outletId: t.outletId, date: businessDate } });
    expect(block.status).toBe(409); expect(block.json.error.code).toBe("OPEN_ORDERS");
    await api.v1("POST", `/orders/${open2}/void`, { cookie: t.cookie, body: { reason: "Guests left before ordering" } });
    const drawer = (await api.v1("GET", `/outlets/${t.outletId}/cash`, { cookie: t.cookie })).json[0];
    expect((await api.v1("POST", "/reports/day-close", { cookie: t.cookie, body: { outletId: t.outletId, date: businessDate } })).json.error.code).toBe("OPEN_CASH_SESSIONS");
    await api.v1("POST", `/cash/sessions/${drawer.id}/close`, { cookie: t.cookie, body: { countedCashCents: drawer.breakdown.expectedCents } });
    const closed = await api.v1("POST", "/reports/day-close", { cookie: t.cookie, body: { outletId: t.outletId, date: businessDate } });
    expect(closed.status).toBe(200); expect(closed.json.summary.sales.totalCents).toBe(6500); expect(closed.json.summary.reconciliation.ok).toBe(true);
    expect((await api.v1("POST", "/reports/day-close", { cookie: t.cookie, body: { outletId: t.outletId, date: businessDate } })).json.error.code).toBe("DAY_ALREADY_CLOSED");
    expect((await api.v1("POST", url, { cookie: sup.cookie, body: { reason: "Too late" } })).json.error.code).toBe("DAY_CLOSED");
  });
});

describe("cash drawer sessions", () => {
  it("expected cash, pay-in/out, variance on close, and cash payments require an open drawer", async () => {
    const t = await createTenant(); const m = await seedMenu(t);
    const cashier = await addEmployee(t, "cashier"); const other = await addEmployee(t, "cashier");
    const id = await openOrder(t, "T1", 1);
    await addItem(id, t.cookie, m.soup); await api.v1("POST", `/orders/${id}/send`, { cookie: t.cookie });
    const nodrawer = await api.v1("POST", `/orders/${id}/payments`, { cookie: cashier.cookie, body: payBody({ method: "cash", amountCents: 4000 }) });
    expect(nodrawer.status).toBe(409); expect(nodrawer.json.error.code).toBe("CASH_SESSION_REQUIRED");
    const s = await openCashDrawer(t, cashier.cookie, 20000);
    expect((await api.v1("POST", "/cash/sessions", { cookie: other.cookie, body: { outletId: t.outletId, openingFloatCents: 100 } })).json.error.code).toBe("CASH_SESSION_OPEN");
    await api.v1("POST", `/orders/${id}/payments`, { cookie: cashier.cookie, body: payBody({ method: "cash", amountCents: 4000, tipCents: 300, tenderedCents: 5000 }) });
    expect((await api.v1("POST", `/cash/sessions/${s.id}/movements`, { cookie: cashier.cookie, body: { kind: "pay_out", amountCents: 1000, reason: "Ice delivery" } })).status).toBe(201);
    expect((await api.v1("POST", `/cash/sessions/${s.id}/movements`, { cookie: cashier.cookie, body: { kind: "pay_out", amountCents: 99999999, reason: "Too much" } })).json.error.code).toBe("INSUFFICIENT_CASH");
    await api.v1("POST", `/cash/sessions/${s.id}/movements`, { cookie: cashier.cookie, body: { kind: "pay_in", amountCents: 500, reason: "Change from bank" } });
    const cur = (await api.v1("GET", `/cash/sessions/${s.id}`, { cookie: cashier.cookie })).json;
    // 20000 float + 4000 sale + 300 cash tip + 500 in − 1000 out
    expect(cur.breakdown).toMatchObject({ cashSalesCents: 4000, cashTipsCents: 300, payInCents: 500, payOutCents: 1000, expectedCents: 23800 });
    expect((await api.v1("POST", `/cash/sessions/${s.id}/close`, { cookie: other.cookie, body: { countedCashCents: 23800 } })).json.error.code).toBe("CASH_SESSION_OWNER");
    const closed = await api.v1("POST", `/cash/sessions/${s.id}/close`, { cookie: cashier.cookie, body: { countedCashCents: 23700, note: "1 MAD short" } });
    expect(closed.json).toMatchObject({ status: "closed", expectedCashCents: 23800, countedCashCents: 23700, varianceCents: -100 });
    const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const rec = (await api.v1("GET", `/reports/reconcile?from=${day(-1)}&to=${day(1)}&outletId=${t.outletId}`, { cookie: t.cookie })).json;
    expect(rec.cashVariances[0].varianceCents).toBe(-100);
  });
});

describe("menu management", () => {
  it("outlet overrides, 86'ing, price-change audit, and import/export", async () => {
    const t = await createTenant(); const m = await seedMenu(t);
    const o2 = (await api.v1("POST", "/outlets", { cookie: t.cookie, body: { name: "Second outlet" } })).json.id as string;
    expect((await api.v1("PUT", `/menu/products/${m.tea}/outlets/${t.outletId}`, { cookie: t.cookie, body: { priceCents: 3000 } })).status).toBe(200);
    const menu1 = (await api.v1("GET", `/outlets/${t.outletId}/menu`, { cookie: t.cookie })).json.products.find((p: { name: string }) => p.name === "Mint tea");
    const menu2 = (await api.v1("GET", `/outlets/${o2}/menu`, { cookie: t.cookie })).json.products.find((p: { name: string }) => p.name === "Mint tea");
    expect(menu1.priceCents).toBe(3000); expect(menu2.priceCents).toBe(2500);
    const id = await openOrder(t, "T1", 1);
    expect((await addItem(id, t.cookie, m.tea)).json.totals.totalCents).toBe(3000);
    // 86 at one outlet only
    await api.v1("PATCH", `/outlets/${t.outletId}/products/${m.soup}/availability`, { cookie: t.cookie, body: { available: false } });
    const out = await addItem(id, t.cookie, m.soup);
    expect(out.status).toBe(409); expect(out.json.error.code).toBe("OUT_OF_STOCK");
    await api.v1("PATCH", `/outlets/${t.outletId}/products/${m.soup}/availability`, { cookie: t.cookie, body: { available: true } });
    expect((await addItem(id, t.cookie, m.soup)).status).toBe(200);
    // price changes are audited with the previous price; order lines keep their snapshot price
    await api.v1("PATCH", `/menu/products/${m.soup}`, { cookie: t.cookie, body: { priceCents: 4500 } });
    const log = (await api.v1("GET", "/audit?action=product.price_change", { cookie: t.cookie })).json[0];
    expect(log.metadata).toMatchObject({ priceCents: 4500, previousPriceCents: 4000 });
    expect((await api.v1("GET", `/orders/${id}`, { cookie: t.cookie })).json.items.find((i: { name: string }) => i.name === "Harira soup").unitPriceCents).toBe(4000);
    // export → import round trip into a second tenant
    const exp = (await api.v1("GET", "/menu/export", { cookie: t.cookie })).json;
    expect(exp.products.length).toBe(5);
    const t2 = await createTenant();
    const imp = await api.v1("POST", "/menu/import", { cookie: t2.cookie, body: exp });
    expect(imp.status).toBe(200); expect(imp.json.created).toBe(5);
    expect((await api.v1("POST", "/menu/import", { cookie: t2.cookie, body: exp })).json).toMatchObject({ created: 0, updated: 5 });
    const bad = await api.v1("POST", "/menu/import", { cookie: t2.cookie, body: { products: [{ name: "X", priceCents: 100, taxRateBps: 1234 }] } });
    expect(bad.json.error.code).toBe("UNKNOWN_TAX_RATE");
  });
});

describe("employees, PIN login and session policies", () => {
  it("locks after repeated wrong PINs, supports unlock by a manager, and never reveals which part was wrong", async () => {
    const t = await createTenant();
    const server = await addEmployee(t, "server", { pin: "2580" });
    const ip = nextIp();
    for (let i = 0; i < 5; i++) {
      const r = await api.auth("POST", "/pin-login", { body: { outletCode: t.code, employeeId: server.id, pin: "1111" }, ip });
      expect(r.status).toBe(401);
    }
    const locked = await api.auth("POST", "/pin-login", { body: { outletCode: t.code, employeeId: server.id, pin: "2580" }, ip });
    expect(locked.status).toBe(423);
    await api.v1("PATCH", `/employees/${server.id}`, { cookie: t.cookie, body: { unlock: true } });
    expect((await api.auth("POST", "/pin-login", { body: { outletCode: t.code, employeeId: server.id, pin: "2580" }, ip: nextIp() })).status).toBe(200);
    expect((await api.auth("POST", "/pin-login", { body: { outletCode: "ZZZZZZ", employeeId: server.id, pin: "2580" }, ip: nextIp() })).status).toBe(401);
    const staff = await api.auth("GET", `/staff?code=${t.code}`, { ip: nextIp() });
    expect(staff.json.staff.map((s: { name: string }) => s.name)).toContain(server.name);
    expect(JSON.stringify(staff.json)).not.toMatch(/pin|hash/i);
  });

  it("idle sessions are locked automatically; deactivated employees lose access immediately; weak PINs are refused", async () => {
    const t = await createTenant();
    const server = await addEmployee(t, "server");
    expect((await api.v1("GET", "/outlets", { cookie: server.cookie })).status).toBe(200);
    const { withSystem } = await import("@/lib/db");
    await withSystem((db) => db.exec(`UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE employee_id = $1`, [server.id]));
    expect((await api.v1("GET", "/outlets", { cookie: server.cookie })).status).toBe(401);          // idle lock (15 min default)
    const again = await addEmployee(t, "server");
    await api.v1("PATCH", `/employees/${again.id}`, { cookie: t.cookie, body: { active: false } });
    expect((await api.v1("GET", "/outlets", { cookie: again.cookie })).status).toBe(401);
    expect((await api.v1("POST", "/employees", { cookie: t.cookie, body: { name: "Weak", role: "server", pin: "1234" } })).json.error.code).toBe("WEAK_PIN");
    expect((await api.v1("POST", "/employees", { cookie: t.cookie, body: { name: "Weak", role: "server", pin: "7777" } })).json.error.code).toBe("WEAK_PIN");
  });

  it("role matrix: kitchen cannot sell, servers cannot manage the menu or see reports, managers cannot create owners, POS sessions are bound to their outlet", async () => {
    const t = await createTenant();
    const kitchen = await addEmployee(t, "kitchen"); const server = await addEmployee(t, "server"); const mgr = await addEmployee(t, "manager");
    expect((await api.v1("POST", "/orders", { cookie: kitchen.cookie, body: { outletId: t.outletId, type: "takeaway" } })).status).toBe(403);
    expect((await api.v1("GET", `/stations/${t.stations.kitchen}/board`, { cookie: kitchen.cookie })).status).toBe(200);
    expect((await api.v1("POST", "/menu/products", { cookie: server.cookie, body: {} })).status).toBe(403);
    expect((await api.v1("GET", `/reports/summary?from=2026-01-01&to=2026-01-02`, { cookie: server.cookie })).status).toBe(403);
    expect((await api.v1("POST", "/employees", { cookie: mgr.cookie, body: { name: "Boss", role: "owner", pin: "2468" } })).json.error.code).toBe("ROLE_NOT_ASSIGNABLE");
    expect((await api.v1("PUT", "/integration/settings", { cookie: mgr.cookie, body: { adapter: "mock", shareSales: true, shareItems: false, shareRefunds: true, shareKitchen: false } })).status).toBe(403);
    const o2 = (await api.v1("POST", "/outlets", { cookie: t.cookie, body: { name: "Other outlet" } })).json.id as string;
    expect((await api.v1("GET", `/outlets/${o2}/floor`, { cookie: server.cookie })).json.error.code).toBe("OUTLET_FORBIDDEN");   // terminal bound to the first outlet
    expect((await api.v1("GET", `/outlets/${o2}/floor`, { cookie: t.cookie })).status).toBe(200);                                 // back-office owner sees all outlets
  });

  it("CSRF: cookie-authenticated writes without a matching Origin are refused", async () => {
    const t = await createTenant();
    expect((await api.v1("POST", "/orders", { cookie: t.cookie, origin: null, body: {} })).json.error.code).toBe("CSRF");
    expect((await api.v1("POST", "/orders", { cookie: t.cookie, origin: "https://evil.example", body: {} })).json.error.code).toBe("CSRF");
  });
});
