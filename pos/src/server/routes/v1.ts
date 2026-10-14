import { z } from "zod";
import { Router } from "@/server/http/router";
import { authed, json } from "@/lib/api";
import { withOrg, withSystem } from "@/lib/db";
import { assertOutletAccess, type Ctx } from "@/lib/auth";
import { forbidden } from "@/lib/errors";
import { idempotent } from "@/server/idempotency";
import * as outlets from "@/server/outlets/service";
import * as menu from "@/server/menu/service";
import * as staff from "@/server/staff/service";
import * as orders from "@/server/orders/service";
import * as kitchen from "@/server/kitchen/service";
import * as cash from "@/server/cash/service";
import * as pay from "@/server/payments/service";
import * as reports from "@/server/reports/service";
import * as integ from "@/server/integration/service";
import { runOutbox } from "@/server/integration/dispatcher";

export const v1 = new Router("/api/v1");
const tx = <T,>(ctx: Ctx, fn: Parameters<typeof withOrg<T>>[1]) => withOrg(ctx.orgId, fn);
const empty = z.object({});
const outletQuery = z.object({ outletId: z.uuid() });

/* ───── Outlets, floor ───── */
v1.add("GET", "/outlets", "pos.access", "Outlets the employee can access", authed("pos.access", (a) => tx(a.ctx, (db) => outlets.listOutlets(db, a.ctx))));
v1.add("POST", "/outlets", "settings.manage", "Create an outlet", authed("settings.manage", async (a) => json(await tx(a.ctx, async (db) => outlets.createOutlet(db, a.ctx, await a.body(outlets.outletCreateSchema))), 201)));
v1.add("PATCH", "/outlets/:id", "settings.manage", "Update outlet settings (tax mode, service charge, idle lock, receipt...)", authed("settings.manage", async (a) => tx(a.ctx, async (db) => outlets.updateOutlet(db, a.ctx, a.params.id, await a.body(outlets.outletUpdateSchema)))));
v1.add("GET", "/outlets/:id/layout", "pos.access", "Rooms, tables and stations of an outlet", authed("pos.access", (a) => tx(a.ctx, (db) => outlets.listRoomsAndTables(db, a.ctx, a.params.id))));
v1.add("GET", "/outlets/:id/floor", "pos.access", "Live floor: tables with their current order and status", authed("pos.access", (a) => tx(a.ctx, (db) => outlets.floorState(db, a.ctx, a.params.id))));
v1.add("POST", "/outlets/:id/rooms", "floor.manage", "Create a dining room", authed("floor.manage", async (a) => json(await tx(a.ctx, async (db) => outlets.createRoom(db, a.ctx, a.params.id, await a.body(outlets.roomSchema))), 201)));
v1.add("PATCH", "/rooms/:id", "floor.manage", "Update a dining room", authed("floor.manage", async (a) => { await tx(a.ctx, async (db) => outlets.updateRoom(db, a.ctx, a.params.id, await a.body(outlets.roomSchema.partial().extend({ active: z.boolean().optional() })))); return { ok: true }; }));
v1.add("POST", "/rooms/:id/tables", "floor.manage", "Create a table", authed("floor.manage", async (a) => json(await tx(a.ctx, async (db) => outlets.createTable(db, a.ctx, a.params.id, await a.body(outlets.tableSchema))), 201)));
v1.add("PATCH", "/tables/:id", "floor.manage", "Update a table (position, seats, assigned server...)", authed("floor.manage", async (a) => { await tx(a.ctx, async (db) => outlets.updateTable(db, a.ctx, a.params.id, await a.body(outlets.tableSchema.partial().extend({ active: z.boolean().optional() })))); return { ok: true }; }));
v1.add("POST", "/outlets/:id/stations", "floor.manage", "Create a preparation station", authed("floor.manage", async (a) => json(await tx(a.ctx, async (db) => outlets.createStation(db, a.ctx, a.params.id, await a.body(outlets.stationSchema))), 201)));
v1.add("PATCH", "/stations/:id", "floor.manage", "Update a station", authed("floor.manage", async (a) => { await tx(a.ctx, async (db) => outlets.updateStation(db, a.ctx, a.params.id, await a.body(outlets.stationSchema.partial().extend({ active: z.boolean().optional() })))); return { ok: true }; }));

/* ───── Menu ───── */
v1.add("GET", "/outlets/:id/menu", "pos.access", "Menu as sold at an outlet (overrides applied)", authed("pos.access", (a) => tx(a.ctx, (db) => menu.menuForOutlet(db, a.ctx, a.params.id))));
v1.add("GET", "/discounts", "pos.access", "Discount catalog", authed("pos.access", (a) => tx(a.ctx, (db) => menu.listDiscounts(db))));
v1.add("GET", "/menu/products", "menu.manage", "All products (back office)", authed("menu.manage", (a) => tx(a.ctx, (db) => menu.listProducts(db))));
v1.add("POST", "/menu/products", "menu.manage", "Create a product", authed("menu.manage", async (a) => json(await tx(a.ctx, async (db) => menu.createProduct(db, a.ctx, await a.body(menu.productSchema))), 201)));
v1.add("PATCH", "/menu/products/:id", "menu.manage", "Update a product (price changes are audited)", authed("menu.manage", async (a) => { await tx(a.ctx, async (db) => menu.updateProduct(db, a.ctx, a.params.id, await a.body(menu.productSchema.partial().extend({ active: z.boolean().optional(), available: z.boolean().optional() })))); return { ok: true }; }));
v1.add("PUT", "/menu/products/:id/outlets/:outletId", "menu.manage", "Outlet-specific price/availability", authed("menu.manage", async (a) => { await tx(a.ctx, async (db) => menu.setProductOutlet(db, a.ctx, a.params.id, a.params.outletId, await a.body(menu.outletProductSchema))); return { ok: true }; }));
v1.add("PATCH", "/outlets/:id/products/:productId/availability", "orders.edit", "86 / un-86 a product at an outlet (out-of-stock control)", authed("orders.edit", async (a) => {
  const b = await a.body(z.object({ available: z.boolean() }));
  if (!["owner", "manager", "supervisor"].includes(a.ctx.role) && a.ctx.role !== "server" && a.ctx.role !== "bartender" && a.ctx.role !== "cashier") throw forbidden();
  await tx(a.ctx, (db) => menu.setProductOutlet(db, a.ctx, a.params.productId, a.params.id, { available: b.available })); return { ok: true };
}));
v1.add("GET", "/menu/categories", "menu.manage", "Categories", authed("menu.manage", (a) => tx(a.ctx, (db) => db.query(`SELECT id, parent_id, name, sort, color, active FROM categories ORDER BY sort, name`))));
v1.add("POST", "/menu/categories", "menu.manage", "Create a category", authed("menu.manage", async (a) => json(await tx(a.ctx, async (db) => menu.createCategory(db, a.ctx, await a.body(menu.categorySchema))), 201)));
v1.add("PATCH", "/menu/categories/:id", "menu.manage", "Update a category", authed("menu.manage", async (a) => { await tx(a.ctx, async (db) => menu.updateCategory(db, a.ctx, a.params.id, await a.body(menu.categorySchema.partial().extend({ active: z.boolean().optional() })))); return { ok: true }; }));
v1.add("GET", "/menu/modifier-groups", "menu.manage", "Modifier groups", authed("menu.manage", (a) => tx(a.ctx, (db) => menu.listModifierGroups(db))));
v1.add("POST", "/menu/modifier-groups", "menu.manage", "Create a modifier group", authed("menu.manage", async (a) => json(await tx(a.ctx, async (db) => menu.createModifierGroup(db, a.ctx, await a.body(menu.modifierGroupSchema))), 201)));
v1.add("GET", "/menu/tax-rates", "menu.manage", "Tax rates", authed("menu.manage", (a) => tx(a.ctx, (db) => menu.listTaxRates(db))));
v1.add("POST", "/menu/tax-rates", "settings.manage", "Create a tax rate", authed("settings.manage", async (a) => json(await tx(a.ctx, async (db) => menu.createTaxRate(db, a.ctx, await a.body(menu.taxRateSchema))), 201)));
v1.add("POST", "/menu/discounts", "menu.manage", "Create a catalog discount", authed("menu.manage", async (a) => json(await tx(a.ctx, async (db) => menu.createDiscount(db, a.ctx, await a.body(menu.discountSchema))), 201)));
v1.add("GET", "/menu/export", "menu.manage", "Export the menu as JSON", authed("menu.manage", (a) => tx(a.ctx, (db) => menu.exportMenu(db))));
v1.add("POST", "/menu/import", "menu.manage", "Import menu items from JSON (upsert, never deletes)", authed("menu.manage", async (a) => tx(a.ctx, async (db) => menu.importMenu(db, a.ctx, await a.body(menu.menuImportSchema)))));

/* ───── Staff ───── */
v1.add("GET", "/employees", "staff.manage", "Employees", authed("staff.manage", (a) => tx(a.ctx, (db) => staff.listEmployees(db))));
v1.add("POST", "/employees", "staff.manage", "Create an employee (PIN and/or back-office password)", authed("staff.manage", async (a) => json(await tx(a.ctx, async (db) => staff.createEmployee(db, a.ctx, await a.body(staff.employeeSchema))), 201)));
v1.add("PATCH", "/employees/:id", "staff.manage", "Update / deactivate / unlock an employee", authed("staff.manage", async (a) => { await tx(a.ctx, async (db) => staff.updateEmployee(db, a.ctx, a.params.id, await a.body(staff.employeeSchema.partial().extend({ active: z.boolean().optional(), unlock: z.boolean().optional() })))); return { ok: true }; }));

/* ───── Orders ───── */
const mutate = <T,>(a: { ctx: Ctx; idempotencyKey: string | null }, scope: string, fn: (db: Parameters<Parameters<typeof withOrg<T>>[1]>[0]) => Promise<T>) =>
  tx(a.ctx, (db) => idempotent(db, a.ctx.orgId, scope, a.idempotencyKey, () => fn(db)));

v1.add("POST", "/orders", "orders.create", "Open an order (dine-in with covers, takeaway, room service, delivery)", authed("orders.create", async (a) => { const b = await a.body(orders.openOrderSchema); return json(await mutate(a, "order.open", (db) => orders.openOrder(db, a.ctx, b)), 201); }));
v1.add("GET", "/orders", "pos.access", "Search orders by outlet / business date / status", authed("pos.access", (a) => tx(a.ctx, (db) => orders.searchOrders(db, a.ctx, a.query(orders.orderSearchSchema)))));
v1.add("GET", "/outlets/:id/open-orders", "pos.access", "Open orders of an outlet", authed("pos.access", (a) => tx(a.ctx, (db) => orders.listOpenOrders(db, a.ctx, a.params.id))));
v1.add("GET", "/orders/:id", "pos.access", "Order with items, totals and payments", authed("pos.access", (a) => tx(a.ctx, (db) => orders.getOrderView(db, a.ctx, a.params.id))));
v1.add("GET", "/orders/:id/receipt", "pos.access", "Receipt data", authed("pos.access", (a) => tx(a.ctx, (db) => pay.receiptFor(db, a.ctx, a.params.id))));
v1.add("POST", "/orders/:id/items", "orders.edit", "Add items (modifiers, notes, seat, course, hold)", authed("orders.edit", async (a) => { const b = await a.body(orders.addItemsSchema); return mutate(a, `order.items:${a.params.id}`, (db) => orders.addItems(db, a.ctx, a.params.id, b)); }));
v1.add("PATCH", "/orders/:id/items/:itemId", "orders.edit", "Edit an unsent item", authed("orders.edit", async (a) => tx(a.ctx, async (db) => orders.updateItem(db, a.ctx, a.params.id, a.params.itemId, await a.body(orders.updateItemSchema)))));
v1.add("POST", "/orders/:id/items/:itemId/void", "orders.edit", "Void an item (reason mandatory; sent items need supervisor authority)", authed("orders.edit", async (a) => tx(a.ctx, async (db) => orders.voidItem(db, a.ctx, a.params.id, a.params.itemId, await a.body(orders.voidItemSchema)))));
v1.add("POST", "/orders/:id/send", "orders.send", "Send new items to the kitchen / bar", authed("orders.send", (a) => mutate(a, `order.send:${a.params.id}`, (db) => orders.sendOrder(db, a.ctx, a.params.id))));
v1.add("POST", "/orders/:id/fire", "orders.send", "Fire a held course", authed("orders.send", async (a) => { const b = await a.body(z.object({ course: z.number().int().min(1).max(6) })); return mutate(a, `order.fire:${a.params.id}:${b.course}`, (db) => orders.fireCourse(db, a.ctx, a.params.id, b.course)); }));
v1.add("POST", "/orders/:id/serve", "orders.edit", "Mark ready items as served", authed("orders.edit", async (a) => { const b = await a.body(z.object({ itemIds: z.array(z.uuid()).optional() })); return tx(a.ctx, (db) => orders.serveItems(db, a.ctx, a.params.id, b.itemIds)); }));
v1.add("POST", "/orders/:id/bill-request", "orders.edit", "Mark the table as awaiting payment", authed("orders.edit", (a) => tx(a.ctx, (db) => orders.requestBill(db, a.ctx, a.params.id))));
v1.add("POST", "/orders/:id/transfer", "orders.transfer", "Move the order to another table", authed("orders.transfer", async (a) => { const b = await a.body(z.object({ tableId: z.uuid() })); return mutate(a, `order.transfer:${a.params.id}`, (db) => orders.transferTable(db, a.ctx, a.params.id, b.tableId)); }));
v1.add("POST", "/orders/:id/combine", "orders.transfer", "Combine additional tables onto the order", authed("orders.transfer", async (a) => { const b = await a.body(z.object({ tableIds: z.array(z.uuid()).min(1).max(10) })); return tx(a.ctx, (db) => orders.combineTables(db, a.ctx, a.params.id, b.tableIds)); }));
v1.add("POST", "/orders/:id/release-table", "orders.transfer", "Split a combined table off the order", authed("orders.transfer", async (a) => { const b = await a.body(z.object({ tableId: z.uuid() })); return tx(a.ctx, (db) => orders.releaseTable(db, a.ctx, a.params.id, b.tableId)); }));
v1.add("POST", "/orders/:id/move-items", "orders.split", "Split items into a new check, or move them to another order", authed("orders.split", async (a) => { const b = await a.body(orders.moveItemsSchema); return mutate(a, `order.move:${a.params.id}`, (db) => orders.moveItems(db, a.ctx, a.params.id, b)); }));
v1.add("POST", "/orders/:id/merge", "orders.merge", "Merge this order into another", authed("orders.merge", async (a) => { const b = await a.body(z.object({ intoOrderId: z.uuid() })); return mutate(a, `order.merge:${a.params.id}`, (db) => orders.mergeOrders(db, a.ctx, a.params.id, b.intoOrderId)); }));
v1.add("POST", "/orders/:id/discounts", "discounts.apply", "Apply a discount (large/custom ones need approval)", authed("discounts.apply", async (a) => tx(a.ctx, async (db) => orders.applyDiscount(db, a.ctx, a.params.id, await a.body(orders.applyDiscountSchema)))));
v1.add("DELETE", "/orders/:id/discounts/:discountId", "discounts.apply", "Remove an order discount", authed("discounts.apply", (a) => tx(a.ctx, (db) => orders.removeDiscount(db, a.ctx, a.params.id, a.params.discountId))));
v1.add("POST", "/orders/:id/void", "orders.edit", "Void an order (reason + supervisor authority)", authed("orders.edit", async (a) => tx(a.ctx, async (db) => orders.voidOrder(db, a.ctx, a.params.id, await a.body(orders.reasonApprovalSchema)))));
v1.add("POST", "/orders/:id/reopen", "orders.edit", "Reopen a closed order (supervisor authority, audited)", authed("orders.edit", async (a) => tx(a.ctx, async (db) => orders.reopenOrder(db, a.ctx, a.params.id, await a.body(orders.reasonApprovalSchema)))));

/* ───── Payments ───── */
v1.add("POST", "/orders/:id/payments", "payments.take", "Take a payment (cash, card via provider, other). 402 when the provider declines.", authed("payments.take", async (a) => {
  const b = await a.body(pay.paySchema);
  const r = await pay.payOrder(a.ctx, a.params.id, b);
  return json(r, r.ok ? 201 : r.payment.status === "pending" ? 202 : 402);
}));
v1.add("POST", "/orders/:id/close-zero", "payments.take", "Close an order whose total is zero", authed("payments.take", (a) => pay.closeZeroOrder(a.ctx, a.params.id)));
v1.add("POST", "/payments/:id/refunds", "refunds.create", "Refund a payment (reason + approver, audited)", authed("refunds.create", async (a) => { const b = await a.body(pay.refundSchema); return json(await pay.refundPayment(a.ctx, a.params.id, b), 201); }));

/* ───── Kitchen / KDS ───── */
v1.add("GET", "/outlets/:id/stations", "kds.use", "Stations of an outlet", authed("kds.use", (a) => tx(a.ctx, (db) => kitchen.listStations(db, a.ctx, a.params.id))));
v1.add("GET", "/stations/:id/board", "kds.use", "Tickets for a station", authed("kds.use", (a) => tx(a.ctx, (db) => kitchen.stationBoard(db, a.ctx, a.params.id))));
v1.add("POST", "/stations/:id/action", "kds.use", "Accept / start / ready / recall items or a whole ticket", authed("kds.use", async (a) => tx(a.ctx, async (db) => kitchen.kdsAction(db, a.ctx, a.params.id, await a.body(kitchen.kdsActionSchema)))));

/* ───── Cash ───── */
v1.add("GET", "/outlets/:id/cash", "cash.session", "Open cash sessions of an outlet", authed("cash.session", (a) => tx(a.ctx, (db) => cash.currentCashSessions(db, a.ctx, a.params.id))));
v1.add("POST", "/cash/sessions", "cash.session", "Open a cash drawer session", authed("cash.session", async (a) => json(await tx(a.ctx, async (db) => cash.openCashSession(db, a.ctx, await a.body(cash.openSessionSchema))), 201)));
v1.add("GET", "/cash/sessions/:id", "cash.session", "Cash session with expected-cash breakdown", authed("cash.session", (a) => tx(a.ctx, (db) => cash.getCashSession(db, a.ctx, a.params.id))));
v1.add("POST", "/cash/sessions/:id/movements", "cash.session", "Pay-in / pay-out", authed("cash.session", async (a) => json(await tx(a.ctx, async (db) => cash.addCashMovement(db, a.ctx, a.params.id, await a.body(cash.movementSchema))), 201)));
v1.add("POST", "/cash/sessions/:id/close", "cash.session", "Close the drawer with the counted cash", authed("cash.session", async (a) => tx(a.ctx, async (db) => cash.closeCashSession(db, a.ctx, a.params.id, await a.body(cash.closeSessionSchema)))));

/* ───── Reports ───── */
const rq = (a: { query: <T>(s: z.ZodType<T>) => T }) => a.query(reports.rangeSchema);
v1.add("GET", "/reports/summary", "reports.view", "Sales summary with previous-period comparison", authed("reports.view", (a) => tx(a.ctx, (db) => reports.salesSummary(db, a.ctx, rq(a)))));
v1.add("GET", "/reports/by-day", "reports.view", "Sales by business day", authed("reports.view", (a) => tx(a.ctx, (db) => reports.salesByDay(db, a.ctx, rq(a)))));
v1.add("GET", "/reports/by-hour", "reports.view", "Sales by hour", authed("reports.view", (a) => tx(a.ctx, (db) => reports.salesByHour(db, a.ctx, rq(a)))));
v1.add("GET", "/reports/by-product", "reports.view", "Product mix", authed("reports.view", (a) => tx(a.ctx, (db) => reports.salesByProduct(db, a.ctx, rq(a)))));
v1.add("GET", "/reports/by-category", "reports.view", "Category performance", authed("reports.view", (a) => tx(a.ctx, (db) => reports.salesByCategory(db, a.ctx, rq(a)))));
v1.add("GET", "/reports/by-employee", "reports.view", "Sales by employee", authed("reports.view", (a) => tx(a.ctx, (db) => reports.salesByEmployee(db, a.ctx, rq(a)))));
v1.add("GET", "/reports/payment-methods", "reports.view", "Payment methods", authed("reports.view", (a) => tx(a.ctx, (db) => reports.paymentMethods(db, a.ctx, rq(a)))));
v1.add("GET", "/reports/discounts-voids", "reports.view", "Discounts, voids, refunds and cancellations", authed("reports.view", (a) => tx(a.ctx, (db) => reports.discountsAndVoids(db, a.ctx, rq(a)))));
v1.add("GET", "/reports/tables", "reports.view", "Table utilisation and turn times", authed("reports.view", (a) => tx(a.ctx, (db) => reports.tableMetrics(db, a.ctx, rq(a)))));
v1.add("GET", "/reports/orders", "reports.view", "Drill-down: source orders", authed("reports.view", (a) => tx(a.ctx, (db) => reports.drillOrders(db, a.ctx, a.query(reports.drillSchema)))));
v1.add("GET", "/reports/reconcile", "reports.view", "Reconciliation of orders vs payments + exceptions", authed("reports.view", (a) => tx(a.ctx, (db) => reports.reconcile(db, a.ctx, rq(a)))));
v1.add("GET", "/reports/end-of-day", "reports.view", "End-of-day / outlet closing report", authed("reports.view", (a) => { const q = a.query(reports.dayCloseSchema); return tx(a.ctx, (db) => reports.endOfDayReport(db, a.ctx, q.outletId, q.date)); }));
v1.add("POST", "/reports/day-close", "day.close", "Close the business day of an outlet", authed("day.close", async (a) => tx(a.ctx, async (db) => reports.closeDay(db, a.ctx, await a.body(reports.dayCloseSchema)))));
v1.add("GET", "/reports/export", "reports.export", "CSV export (kind=products|orders|payments|employees)", authed("reports.export", async (a) => {
  const q = a.query(reports.rangeSchema.and(z.object({ kind: z.enum(["products", "orders", "payments", "employees"]) })));
  const rows = await tx(a.ctx, async (db) => {
    if (q.kind === "products") return reports.salesByProduct(db, a.ctx, q);
    if (q.kind === "employees") return reports.salesByEmployee(db, a.ctx, q);
    if (q.kind === "payments") return reports.paymentMethods(db, a.ctx, q);
    return reports.drillOrders(db, a.ctx, q);
  });
  await tx(a.ctx, (db) => import("@/lib/audit").then((m) => m.audit(db, a.ctx, "report.export", "report", null, { kind: q.kind, from: q.from, to: q.to })));
  return new Response(reports.toCsv(rows as Array<Record<string, unknown>>), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="comptoir-${q.kind}-${q.from}_${q.to}.csv"`, "x-content-type-options": "nosniff" } });
}));

/* ───── Audit ───── */
v1.add("GET", "/audit", "audit.view", "Audit trail (filter by order / outlet / action prefix)", authed("audit.view", async (a) => {
  const q = a.query(z.object({ orderId: z.uuid().optional(), outletId: z.uuid().optional(), action: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }));
  if (q.outletId) assertOutletAccess(a.ctx, q.outletId);
  return tx(a.ctx, (db) => db.query(
    `SELECT id, created_at, outlet_id, actor_label, approver_id, action, entity_type, entity_id, order_id, metadata FROM audit_logs
      WHERE ($1::uuid IS NULL OR order_id = $1) AND ($2::uuid IS NULL OR outlet_id = $2) AND ($3::text IS NULL OR action LIKE $3 || '%') ORDER BY id DESC LIMIT $4`, [q.orderId ?? null, q.outletId ?? null, q.action ?? null, q.limit]));
}));

/* ───── Fluentra integration ───── */
v1.add("GET", "/integration/status", "settings.manage", "Synchronization status, backlog and errors", authed("settings.manage", (a) => tx(a.ctx, (db) => integ.syncStatus(db))));
v1.add("PUT", "/integration/settings", "integration.manage", "Configure the Fluentra adapter and sharing permissions", authed("integration.manage", async (a) => tx(a.ctx, async (db) => integ.putSettings(db, a.ctx, await a.body(integ.settingsSchema)))));
v1.add("POST", "/integration/resync", "settings.manage", "Re-queue failed events and backfill missing order events for a date range", authed("settings.manage", async (a) => tx(a.ctx, async (db) => integ.resync(db, a.ctx, await a.body(integ.resyncSchema)))));
v1.add("POST", "/integration/dispatch", "settings.manage", "Deliver due events now", authed("settings.manage", async (a) => { await a.body(empty); return runOutbox(100); }));
v1.add("GET", "/integration/mock-inbox", "settings.manage", "TEST ONLY: events received by the mock Fluentra", authed("settings.manage", (a) => tx(a.ctx, (db) => integ.mockInbox(db))));

void withSystem;
