# Status — what exists, what is partial, what is not built

"Implemented" means covered by an automated test or by the browser journey (`tests/e2e/journey.mjs`). Verified on this branch: 36 Vitest tests passing, `tsc`, ESLint and `next build` clean, browser journey passing (server PIN login → order with modifiers → send → kitchen bump on the KDS → cash payment → back-office dashboard), no browser console errors.

## Phase 1 — discovery & architecture — done
Existing environment inspected (Next.js + PostgreSQL/RLS stack of Fluentra, Vercel + Neon target); architecture, schema, API contract (generated `docs/API.md`), Fluentra integration plan and regulatory questions are documented. **Fluentra's API was inspected: it has no POS ingestion endpoint** (see FLUENTRA_INTEGRATION.md).

## Phase 2 — functional POS MVP — implemented
- Auth: PIN login per outlet terminal code, back-office email/password, roles (owner, manager, supervisor, cashier, server, bartender, kitchen), permission matrix, supervisor approvals by PIN, lockout, auto-lock on idle, CSRF.
- Organization/outlet/room/table/station/employee setup (signup + back office), multi-outlet.
- Menu: categories, products, modifier groups with min/max rules, allergens, per-outlet price/availability, 86 (out of stock) from the POS, discounts catalog, tax rates, JSON import/export, audited price changes.
- Floor: live plan with status (available / occupied / ordered / awaiting payment), covers, timers, long-stay alert, drag-and-drop editor, walk-ins and takeaway/room-service/delivery orders, transfer / combine / split tables.
- Orders: modifiers, notes, allergy notes, seats, courses, hold & fire, send to kitchen/bar/pastry, add after send, void with reason (+ approval for sent items), split by item/seat, move/merge, discounts (item/order, approval above threshold or custom), reopen (supervisor, audited, blocked after day close), void order.
- KDS: tickets per station, elapsed-time levels vs target, accept/start/ready/recall at item and ticket level, allergy highlighting, cancelled items shown, recently completed list for recall.
- Payments: cash (tendered/change), card through the provider contract (TEST terminal only), other tenders (supervisor), tips, split payments (equal shares / amounts), idempotent, reservation of pending amounts, declines recorded; receipts; refunds (reason + approver, idempotent, cash & card paths).
- Cash: drawer sessions, pay-in/out, expected-cash breakdown, counted close with variance.
- Reports: sales summary with previous-period comparison, by day/hour/product/category/employee/payment method, discounts/voids/refunds/cancellations, table turns, drill-down to orders, reconciliation + exceptions, end-of-day report and day close, CSV exports, audit trail viewer. All reconcile with the transaction records (tested).
- Integrity enforced by the database: closed orders immutable, append-only audit log, composite tenant foreign keys, forced RLS, unique open order per table.
- UI in French and English (French coverage test-enforced), responsive, original brand.

## Phase 3 — reliability — partial
Implemented: idempotency keys on mutations, pessimistic order locking, concurrency tests (12 parallel orders, parallel payments, same-table races), audit trail, online/offline indicator, polling fallback.
**Not implemented:** offline-first operation (no service worker, no local store, no device-to-device coordination, no sync queue on the client). Today an internet/server outage stops order entry; only the *Fluentra* link is outage-tolerant. Planned design: IndexedDB queue of operations keyed by `Idempotency-Key`, replay on reconnect, conflict rules per operation (what can work offline: add items, send to KDS on the local network, cash; what needs connectivity: card payments, approvals). Backups/restore scripts and monitoring/alerting are not provided yet (see OPERATIONS.md).

## Phase 4 — Fluentra integration — partial
POS side complete (outbox, signed HTTP + mock adapters, retries, dead-letter, resync/backfill, monitor, sharing permissions). **No live Fluentra integration exists or was verified.** The Fluentra ingestion endpoint and guest/reservation linking are open work.

## Phase 5 — advanced modules — not built
Inventory, recipes, food cost, purchasing, stock counts, waste · happy-hour/scheduled menus and effective-dated price changes · multi-outlet consolidated management beyond filtering · Arabic dictionary · hardware integrations (ESC/POS printers, drawers, scanners, card terminals) · promotions engine · deposits/prepayments · room-charge to hotel PMS · KDS bump-bar · table-level reservation display from Fluentra.

## Known limitations
- Price changes take effect immediately (no scheduling); open orders keep their snapshot prices.
- A business day is the date the order was opened; very late orders can straddle two days only through the configured start hour.
- Split bill supports items/seats and equal/amount payments; a "split by guest count" does not re-price service charges per share.
- Reopen is refused for orders that have refunds.
- The audit/report screens are in French/English; API error messages are English.
- Test payment mode must stay off in production.
