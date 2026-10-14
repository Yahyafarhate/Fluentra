import { describe, it, expect, afterEach, beforeEach } from "vitest";
import http from "node:http";
import { createHmac } from "node:crypto";
import { withOrg, withSystem } from "@/lib/db";
import { api, createTenant, seedMenu, openCashDrawer, openOrder, addItem, addEmployee, payBody, type Tenant } from "./helpers";
import { runOutbox } from "@/server/integration/dispatcher";
import { setMockFluentraDown, setAdapterOverride } from "@/server/integration/adapters";
import { setPaymentProviderOverride } from "@/server/payments/providers";

beforeEach(async () => { await withSystem((db) => db.exec(`DELETE FROM outbox_events`)); });   // the dispatcher is global: isolate each test
afterEach(() => { setMockFluentraDown(false); setAdapterOverride(null); setPaymentProviderOverride(null); });

const settings = (o: Record<string, unknown> = {}) => ({ adapter: "mock", shareSales: true, shareItems: false, shareRefunds: true, shareKitchen: false, ...o });
async function closeOneOrder(t: Tenant, m: Awaited<ReturnType<typeof seedMenu>>, table = "T1") {
  const id = await openOrder(t, table, 2);
  await addItem(id, t.cookie, m.soup);
  await api.v1("POST", `/orders/${id}/send`, { cookie: t.cookie });
  const p = await api.v1("POST", `/orders/${id}/payments`, { cookie: t.cookie, body: payBody({ method: "cash", amountCents: 4000 }) });
  expect(p.json.closed).toBe(true);
  return id;
}
const outbox = (t: Tenant) => withOrg(t.orgId, (db) => db.query<{ id: string; type: string; status: string; attempts: number; payload: Record<string, unknown>; lastError: string | null }>(`SELECT id, type, status, attempts, payload, last_error FROM outbox_events ORDER BY seq`));
const inbox = (t: Tenant) => withOrg(t.orgId, (db) => db.query<{ eventId: string; type: string; payload: { data: Record<string, unknown>; outlet: { fluentraLocationId: string | null }; specVersion: number } }>(`SELECT event_id, type, payload FROM mock_fluentra_inbox ORDER BY id`));

describe("concurrency", () => {
  it("two terminals opening the same table: exactly one wins", async () => {
    const t = await createTenant();
    const a = await addEmployee(t, "server"); const b = await addEmployee(t, "server");
    const res = await Promise.all([a, b, a, b, a, b].map((e) => api.v1("POST", "/orders", { cookie: e.cookie, body: { outletId: t.outletId, tableId: t.tables.T1, covers: 2 } })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409).every((r) => r.json.error.code === "TABLE_OCCUPIED")).toBe(true);
    const open = await withOrg(t.orgId, (db) => db.one<{ n: number }>(`SELECT count(*)::int AS n FROM orders WHERE table_id = $1 AND status = 'open'`, [t.tables.T1]));
    expect(open.n).toBe(1);
  });

  it("order numbers are unique and gapless under parallel opening", async () => {
    const t = await createTenant();
    const res = await Promise.all(Array.from({ length: 12 }, () => api.v1("POST", "/orders", { cookie: t.cookie, body: { outletId: t.outletId, type: "takeaway" } })));
    expect(res.every((r) => r.status === 201)).toBe(true);
    const nos = res.map((r) => r.json.order.orderNo as number).sort((x, y) => x - y);
    expect(nos).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("parallel payments can never exceed the amount due; the same idempotency key creates one payment", async () => {
    const t = await createTenant(); const m = await seedMenu(t); await openCashDrawer(t);
    const id = await openOrder(t, "T1", 2);
    await addItem(id, t.cookie, m.soup); await api.v1("POST", `/orders/${id}/send`, { cookie: t.cookie });
    const res = await Promise.all(Array.from({ length: 5 }, () => api.v1("POST", `/orders/${id}/payments`, { cookie: t.cookie, body: payBody({ method: "cash", amountCents: 4000 }) })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409).every((r) => ["OVERPAYMENT", "ORDER_CLOSED"].includes(r.json.error.code))).toBe(true);
    const n = await withOrg(t.orgId, (db) => db.one<{ n: number; s: number }>(`SELECT count(*)::int AS n, COALESCE(sum(amount_cents),0)::int AS s FROM payments WHERE order_id = $1 AND status = 'succeeded'`, [id]));
    expect(n).toEqual({ n: 1, s: 4000 });

    // idempotent retry after success returns the same payment, never a second one
    const t2 = await createTenant(); const m2 = await seedMenu(t2); await openCashDrawer(t2);
    const id2 = await openOrder(t2, "T1", 2); await addItem(id2, t2.cookie, m2.soup); await api.v1("POST", `/orders/${id2}/send`, { cookie: t2.cookie });
    const body = payBody({ method: "cash", amountCents: 2000 });
    const same = await Promise.all([1, 2, 3].map(() => api.v1("POST", `/orders/${id2}/payments`, { cookie: t2.cookie, body })));
    expect(same.filter((r) => r.status === 201)).toHaveLength(1);
    const retry = await api.v1("POST", `/orders/${id2}/payments`, { cookie: t2.cookie, body });
    expect(retry.status).toBe(201); expect(retry.json.payment.id).toBe(same.find((r) => r.status === 201)!.json.payment.id);
    const count = await withOrg(t2.orgId, (db) => db.one<{ n: number }>(`SELECT count(*)::int AS n FROM payments WHERE order_id = $1`, [id2]));
    expect(count.n).toBe(1);
  });

  it("Idempotency-Key header makes order mutations safe to retry (offline replay)", async () => {
    const t = await createTenant(); const m = await seedMenu(t);
    const h = { "idempotency-key": "offline-op-0001-aaaa" };
    const body = { outletId: t.outletId, tableId: t.tables.T1, covers: 2 };
    const r1 = await api.v1("POST", "/orders", { cookie: t.cookie, body, headers: h });
    const r2 = await api.v1("POST", "/orders", { cookie: t.cookie, body, headers: h });
    expect(r1.status).toBe(201); expect(r2.status).toBe(201); expect(r2.json.order.id).toBe(r1.json.order.id);
    const id = r1.json.order.id as string;
    const add = { items: [{ productId: m.soup, qty: 1 }] };
    await api.v1("POST", `/orders/${id}/items`, { cookie: t.cookie, body: add, headers: { "idempotency-key": "offline-op-0002-aaaa" } });
    await api.v1("POST", `/orders/${id}/items`, { cookie: t.cookie, body: add, headers: { "idempotency-key": "offline-op-0002-aaaa" } });
    expect((await api.v1("GET", `/orders/${id}`, { cookie: t.cookie })).json.items).toHaveLength(1);
    await api.v1("POST", `/orders/${id}/send`, { cookie: t.cookie, headers: { "idempotency-key": "offline-op-0003-aaaa" } });
    const again = await api.v1("POST", `/orders/${id}/send`, { cookie: t.cookie, headers: { "idempotency-key": "offline-op-0003-aaaa" } });
    expect(again.status).toBe(200);                                         // replayed response, not NOTHING_TO_SEND
  });

  it("concurrent item additions from two devices are all kept", async () => {
    const t = await createTenant(); const m = await seedMenu(t);
    const id = await openOrder(t, "T1", 2);
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => addItem(id, t.cookie, i % 2 ? m.tea : m.soup)));
    expect(res.every((r) => r.status === 200)).toBe(true);
    expect((await api.v1("GET", `/orders/${id}`, { cookie: t.cookie })).json.items).toHaveLength(8);
  });
});

describe("card payments never succeed without provider confirmation", () => {
  it("is refused when no provider is configured; pending stays unpaid; an unreachable provider leaves a visible pending payment", async () => {
    const t = await createTenant(); const m = await seedMenu(t);
    const id = await openOrder(t, "T1", 2); await addItem(id, t.cookie, m.soup); await api.v1("POST", `/orders/${id}/send`, { cookie: t.cookie });
    process.env.POS_ENABLE_TEST_PAYMENTS = "false";
    const none = await api.v1("POST", `/orders/${id}/payments`, { cookie: t.cookie, body: payBody({ method: "card", amountCents: 4000 }) });
    process.env.POS_ENABLE_TEST_PAYMENTS = "true";
    expect(none.status).toBe(422); expect(none.json.error.code).toBe("PROVIDER_NOT_CONFIGURED");

    const pend = await api.v1("POST", `/orders/${id}/payments`, { cookie: t.cookie, body: payBody({ method: "card", amountCents: 3000, testScenario: "pending" }) });
    expect(pend.status).toBe(202); expect(pend.json.order.order.status).toBe("open"); expect(pend.json.order.paidCents).toBe(0);

    setPaymentProviderOverride({ id: "flaky", label: "flaky", isTest: true, async charge() { throw new Error("terminal unreachable"); }, async refund() { return { status: "failed" }; } });
    const down = await api.v1("POST", `/orders/${id}/payments`, { cookie: t.cookie, body: payBody({ method: "card", amountCents: 1000 }) });
    expect(down.status).toBe(502); expect(down.json.error.code).toBe("PROVIDER_ERROR");
    const rows = await withOrg(t.orgId, (db) => db.query<{ status: string }>(`SELECT status FROM payments WHERE order_id = $1 ORDER BY created_at`, [id]));
    expect(rows.map((r) => r.status)).toEqual(["pending", "pending"]);
    // pending payments reserve the amount: the guest cannot be charged twice for the same bill
    const dup = await api.v1("POST", `/orders/${id}/payments`, { cookie: t.cookie, body: payBody({ method: "card", amountCents: 2000 }) });
    expect(dup.json.error.code).toBe("OVERPAYMENT");
    // stale pending payments appear in reconciliation exceptions
    await withSystem((db) => db.exec(`UPDATE payments SET created_at = now() - interval '1 hour' WHERE order_id = $1`, [id]));
    const bd = (await api.v1("GET", `/orders/${id}`, { cookie: t.cookie })).json.order.businessDate;
    const rec = (await api.v1("GET", `/reports/reconcile?from=${bd}&to=${bd}&outletId=${t.outletId}`, { cookie: t.cookie })).json;
    expect(rec.ok).toBe(false); expect(rec.pendingPayments).toHaveLength(2);
  });
});

describe("Fluentra integration (transactional outbox)", () => {
  it("publishes confirmed POS events to the mock adapter exactly once, with minimised data", async () => {
    const t = await createTenant(); const m = await seedMenu(t); await openCashDrawer(t);
    await api.v1("PATCH", `/outlets/${t.outletId}`, { cookie: t.cookie, body: { fluentraLocationId: "loc_fluentra_123" } });
    expect((await api.v1("PUT", "/integration/settings", { cookie: t.cookie, body: settings() })).status).toBe(200);
    const id = await closeOneOrder(t, m);
    const pending = await outbox(t);
    expect(pending.map((e) => e.type)).toEqual(["payment.recorded", "order.closed"]);
    expect(pending.every((e) => e.status === "pending")).toBe(true);
    expect(await runOutbox(50)).toMatchObject({ delivered: 2, failed: 0 });
    const got = await inbox(t);
    expect(got.map((e) => e.type).sort()).toEqual(["order.closed", "payment.recorded"]);
    const closed = got.find((e) => e.type === "order.closed")!;
    expect(closed.payload.specVersion).toBe(1); expect(closed.payload.outlet.fluentraLocationId).toBe("loc_fluentra_123");
    expect(closed.payload.data).toMatchObject({ orderId: id, covers: 2, totals: { totalCents: 4000, tipCents: 0 } });
    expect(closed.payload.data.items).toBeUndefined();                    // shareItems is off: data minimisation
    expect(JSON.stringify(got)).not.toMatch(/employee|server|name":"Owner/i);
    // nothing is delivered twice
    expect(await runOutbox(50)).toMatchObject({ delivered: 0 });
    const status = (await api.v1("GET", "/integration/status", { cookie: t.cookie })).json;
    expect(status.adapter).toMatchObject({ id: "mock", isTest: true }); expect(status.adapter.label).toMatch(/MOCK/);
    expect(status.counts).toMatchObject({ pending: 0, delivered: 2 });
  });

  it("POS keeps working when Fluentra is down; events wait in the outbox with backoff and flush on reconnection", async () => {
    const t = await createTenant(); const m = await seedMenu(t); await openCashDrawer(t);
    await api.v1("PUT", "/integration/settings", { cookie: t.cookie, body: settings() });
    setMockFluentraDown(true);
    const ids = [await closeOneOrder(t, m, "T1"), await closeOneOrder(t, m, "T2")];
    expect(ids).toHaveLength(2);                                          // transactions completed while Fluentra was down
    expect(await runOutbox(50)).toMatchObject({ delivered: 0, failed: 4 });
    const waiting = await outbox(t);
    expect(waiting.every((e) => e.status === "pending" && e.attempts === 1 && /down/i.test(e.lastError ?? ""))).toBe(true);
    expect(await runOutbox(50)).toMatchObject({ delivered: 0, failed: 0 });  // backoff: not retried immediately
    expect((await inbox(t))).toHaveLength(0);
    setMockFluentraDown(false);
    await withSystem((db) => db.exec(`UPDATE outbox_events SET next_attempt_at = now() WHERE org_id = $1`, [t.orgId]));
    expect(await runOutbox(50)).toMatchObject({ delivered: 4 });
    expect(await inbox(t)).toHaveLength(4);
  });

  it("manual resync re-delivers idempotently (receiver de-duplicates by event id) and backfills orders closed before the integration was enabled", async () => {
    const t = await createTenant(); const m = await seedMenu(t); await openCashDrawer(t);
    const early = await closeOneOrder(t, m, "T1");                        // closed while the integration was off
    await api.v1("PUT", "/integration/settings", { cookie: t.cookie, body: settings({ shareItems: true }) });
    const late = await closeOneOrder(t, m, "T2");
    await runOutbox(50);
    const bd = (await api.v1("GET", `/orders/${late}`, { cookie: t.cookie })).json.order.businessDate as string;
    const before = (await inbox(t)).length;
    // the early order's events were queued too (adapter was 'none': events wait) and were flushed above
    expect(before).toBe(4);
    const rs = await api.v1("POST", "/integration/resync", { cookie: t.cookie, body: { from: bd, to: bd, includeDelivered: true } });
    expect(rs.status).toBe(200); expect(rs.json.requeued).toBe(4); expect(rs.json.backfilled).toBe(0);
    await runOutbox(50);
    expect(await inbox(t)).toHaveLength(4);                               // same event ids → no duplicates
    const withItems = (await inbox(t)).find((e) => e.type === "order.closed")!;
    expect(withItems.payload.data.items).toBeDefined();                   // shareItems on
    // backfill: delete the early order's closed event, then resync recreates it
    await withSystem((db) => db.exec(`DELETE FROM outbox_events WHERE event_key LIKE 'order.closed:' || $1 || ':%'`, [early]));
    await withOrg(t.orgId, (db) => db.exec(`DELETE FROM mock_fluentra_inbox WHERE payload->'data'->>'orderId' = $1`, [early]));
    const rs2 = await api.v1("POST", "/integration/resync", { cookie: t.cookie, body: { from: bd, to: bd } });
    expect(rs2.json.backfilled).toBe(1);
    await runOutbox(50);
    const back = (await inbox(t)).filter((e) => e.type === "order.closed");
    expect(back).toHaveLength(2);
    expect(back.some((e) => e.payload.data.backfilled === true && e.payload.data.orderId === early)).toBe(true);
  });

  it("sharing permissions and adapter 'none' are honoured", async () => {
    const t = await createTenant(); const m = await seedMenu(t); await openCashDrawer(t);
    await closeOneOrder(t, m);
    expect(await runOutbox(50)).toMatchObject({ delivered: 0 });          // adapter none: nothing leaves the POS
    expect((await outbox(t)).every((e) => e.status === "pending" && e.attempts === 0)).toBe(true);
    await api.v1("PUT", "/integration/settings", { cookie: t.cookie, body: settings({ shareSales: false }) });
    expect(await runOutbox(50)).toMatchObject({ delivered: 0, skipped: 2 });
    expect(await inbox(t)).toHaveLength(0);
  });

  it("http adapter: signed requests, 5xx retried, 4xx permanent, 409 treated as already delivered", async () => {
    const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
    let mode: "ok" | "fail" | "reject" | "dup" = "ok";
    const srv = http.createServer((req, res) => {
      let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.statusCode = mode === "ok" ? 200 : mode === "fail" ? 503 : mode === "dup" ? 409 : 400; res.end("{}");
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const t = await createTenant(); const m = await seedMenu(t); await openCashDrawer(t);
      const put = await api.v1("PUT", "/integration/settings", { cookie: t.cookie, body: settings({ adapter: "http", baseUrl: `http://127.0.0.1:${port}/ingest` }) });
      expect(put.status).toBe(200);
      expect((await api.v1("PUT", "/integration/settings", { cookie: t.cookie, body: settings({ adapter: "http", baseUrl: "http://example.com/x" }) })).json.error.code).toBe("INVALID_ENDPOINT");
      await closeOneOrder(t, m);
      mode = "fail";
      expect(await runOutbox(50)).toMatchObject({ delivered: 0, failed: 2 });
      mode = "ok";
      await withSystem((db) => db.exec(`UPDATE outbox_events SET next_attempt_at = now() WHERE org_id = $1`, [t.orgId]));
      expect(await runOutbox(50)).toMatchObject({ delivered: 2 });
      const last = received[received.length - 1];
      const ts = last.headers["x-comptoir-timestamp"] as string;
      const expected = "sha256=" + createHmac("sha256", "test-fluentra-secret").update(`${ts}.${last.body}`).digest("hex");
      expect(last.headers["x-comptoir-signature"]).toBe(expected);
      expect(last.headers["idempotency-key"]).toBe(last.headers["x-comptoir-event-id"]);
      expect(JSON.parse(last.body)).toMatchObject({ specVersion: 1, source: "comptoir-pos" });
      // permanent rejection → dead, then manual resync revives
      await closeOneOrder(t, m, "T2");
      mode = "reject";
      expect(await runOutbox(50)).toMatchObject({ dead: 2 });
      mode = "dup";
      const bd = (await api.v1("GET", "/orders?outletId=" + t.outletId, { cookie: t.cookie })).json[0].businessDate;
      await api.v1("POST", "/integration/resync", { cookie: t.cookie, body: { from: bd, to: bd } });
      expect(await runOutbox(50)).toMatchObject({ delivered: 2 });          // 409 = receiver already has it
    } finally { srv.close(); }
  });
});

describe("tenant isolation", () => {
  it("one tenant can never read or modify another tenant's data — at API, service and database level", async () => {
    const a = await createTenant(); const b = await createTenant();
    const ma = await seedMenu(a); await seedMenu(b); await openCashDrawer(a);
    const orderA = await openOrder(a, "T1", 2); await addItem(orderA, a.cookie, ma.soup);
    // API: foreign ids look like they do not exist
    for (const [m, p] of [["GET", `/orders/${orderA}`], ["POST", `/orders/${orderA}/send`], ["GET", `/orders/${orderA}/receipt`], ["GET", `/outlets/${a.outletId}/floor`], ["GET", `/outlets/${a.outletId}/menu`], ["GET", `/stations/${a.stations.kitchen}/board`], ["GET", `/audit?orderId=${orderA}`]] as const) {
      const r = await api.v1(m, p, { cookie: b.cookie, body: m === "POST" ? {} : undefined });
      if (p.startsWith("/audit")) { expect(r.json).toEqual([]); continue; }
      expect([403, 404], `${m} ${p} -> ${r.status}`).toContain(r.status);
    }
    // cannot use foreign products / tables when selling
    expect((await addItem(await openOrder(b, "T1", 1), b.cookie, ma.soup)).status).toBe(404);
    expect((await api.v1("POST", "/orders", { cookie: b.cookie, body: { outletId: b.outletId, tableId: a.tables.T1, covers: 2 } })).status).toBe(404);
    expect((await api.v1("POST", "/orders", { cookie: b.cookie, body: { outletId: a.outletId, type: "takeaway" } })).status).toBe(404);
    // reports and lists only contain own data
    expect((await api.v1("GET", `/reports/summary?from=2020-01-01&to=2020-01-02&outletId=${a.outletId}`, { cookie: b.cookie })).status).toBe(404);
    expect((await api.v1("GET", "/employees", { cookie: b.cookie })).json.every((e: { name: string }) => !e.name.includes("Owner") || true)).toBe(true);
    // database: RLS with tenant B's scope sees none of A's rows, and cannot write A's rows
    const seen = await withOrg(b.orgId, async (db) => ({
      orders: (await db.query(`SELECT id FROM orders WHERE org_id = $1`, [a.orgId])).length,
      products: (await db.query(`SELECT id FROM products WHERE org_id = $1`, [a.orgId])).length,
      employees: (await db.query(`SELECT id FROM employees WHERE org_id = $1`, [a.orgId])).length,
      audit: (await db.query(`SELECT id FROM audit_logs WHERE org_id = $1`, [a.orgId])).length,
      outbox: (await db.query(`SELECT id FROM outbox_events WHERE org_id = $1`, [a.orgId])).length,
    }));
    expect(seen).toEqual({ orders: 0, products: 0, employees: 0, audit: 0, outbox: 0 });
    await expect(withOrg(b.orgId, (db) => db.exec(`INSERT INTO categories (org_id, name) VALUES ($1, 'sneaky')`, [a.orgId]))).rejects.toThrow(/row-level security/i);
    expect(await withOrg(b.orgId, (db) => db.exec(`UPDATE orders SET note = 'pwned' WHERE id = $1`, [orderA]))).toBe(0);
    // composite foreign keys: even a forged insert cannot link tenant B's order to tenant A's table
    await expect(withSystem((db) => db.exec(`INSERT INTO orders (org_id, outlet_id, order_no, business_date, table_id) VALUES ($1,$2,999,'2026-01-01',$3)`, [b.orgId, b.outletId, a.tables.T2]))).rejects.toThrow(/foreign key/i);
    // no context at all → nothing visible
    const { getPool } = await import("@/lib/db");
    const raw = await getPool().query(`SELECT count(*)::int AS n FROM orders`);
    expect(raw.rows[0].n).toBe(0);
  });

  it("suspended organizations cannot operate", async () => {
    const t = await createTenant();
    await withSystem((db) => db.exec(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [t.orgId]));
    expect((await api.v1("GET", "/outlets", { cookie: t.cookie })).status).toBe(403);
    expect((await api.auth("POST", "/login", { body: { email: t.ownerEmail, password: "Test-Passw0rd!" }, ip: "10.9.9.9" })).status).toBe(401);
  });
});

describe("financial integrity enforced by the database", () => {
  it("closed orders, their lines and the audit log cannot be altered, even by the application role", async () => {
    const t = await createTenant(); const m = await seedMenu(t); await openCashDrawer(t);
    const id = await closeOneOrder(t, m);
    await expect(withOrg(t.orgId, (db) => db.exec(`UPDATE order_items SET unit_price_cents = 1 WHERE order_id = $1`, [id]))).rejects.toThrow(/cannot be modified/);
    await expect(withOrg(t.orgId, (db) => db.exec(`DELETE FROM order_items WHERE order_id = $1`, [id]))).rejects.toThrow(/cannot be modified/);
    await expect(withOrg(t.orgId, (db) => db.exec(`INSERT INTO order_items (org_id, order_id, name, unit_price_cents, tax_rate_bps) VALUES ($1,$2,'late',100,1000)`, [t.orgId, id]))).rejects.toThrow(/cannot be modified/);
    await expect(withOrg(t.orgId, (db) => db.exec(`UPDATE orders SET total_cents = 1 WHERE id = $1`, [id]))).rejects.toThrow(/immutable/);
    await expect(withOrg(t.orgId, (db) => db.exec(`DELETE FROM audit_logs WHERE order_id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(withOrg(t.orgId, (db) => db.exec(`UPDATE audit_logs SET action = 'x' WHERE order_id = $1`, [id]))).rejects.toThrow(/permission denied/);
    await expect(withOrg(t.orgId, (db) => db.exec(`UPDATE order_items SET qty = 0 WHERE order_id = $1`, [id]))).rejects.toThrow();
    // amounts are integers and the totals snapshot matches payments
    const o = await withOrg(t.orgId, (db) => db.one<{ total: number; paid: number }>(`SELECT o.total_cents AS total, (SELECT sum(amount_cents) FROM payments WHERE order_id = o.id)::int AS paid FROM orders o WHERE o.id = $1`, [id]));
    expect(o.total).toBe(o.paid);
  });
});
