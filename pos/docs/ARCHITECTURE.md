# Architecture

## Boundaries
```
Browser (POS, KDS, back office)  →  /api/auth/*, /api/v1/*  (declarative Router: one table = method, path, permission, handler)
                                        │
                  src/server/<module>/service.ts  — business rules, one DB transaction per request
                                        │
                  src/lib/db.ts  withOrg(orgId, tx)  — sets app.org_id for Row Level Security
                                        │
                              PostgreSQL 16 (own database)
Outbox (same transaction) ──► dispatcher ──► adapter (mock | signed HTTPS) ──► Fluentra
```
Modules: `outlets` (rooms, tables, stations, floor state), `menu`, `staff`, `orders` (+ pure `totals.ts`), `kitchen`, `payments` (+ `providers.ts`), `cash`, `reports`, `integration`, `setup`. Each module exports services and Zod schemas; routes only wire them.

## Why not NestJS / React SPA
The brief recommended NestJS "if starting from scratch". The environment already contained a tested Next.js + PostgreSQL + RLS stack (Fluentra). Reusing it gives the same security model, tooling and i18n conventions, one deployable runtime and no second framework to operate. The module boundaries above are explicit so a service layer could later be extracted into a separate API process without touching business rules.

## Tenant isolation (defence in depth)
1. Every tenant table has `org_id` with `ENABLE` + `FORCE ROW LEVEL SECURITY`; policies compare `org_id` with `app_org()`, read from a transaction-local setting set by `withOrg`. The runtime role `comptoir_app` is non-superuser and non-owner.
2. Composite foreign keys `(id, org_id)` make cross-tenant references impossible even for a forged insert.
3. Server-side permission + outlet checks on every route; POS sessions are bound to one outlet.
4. Tests attack all three layers (`tests/reliability.test.ts`).

## Money
All amounts are integer centimes. Division goes through `roundDiv` (half-up on integers) and splits through `allocate` (largest remainder) so parts always add up. `computeTotals` is a pure function; the closed-order snapshot (`totals_snapshot` and the `*_cents` columns) is what reports read, and database triggers make it immutable.

Order of operations: line = qty × unit − item discount → order discounts applied sequentially to the running base and spread over lines → service charge on the discounted items → tax per rate group (inclusive: `gross × r / (1 + r)`, exclusive: `base × r`). Tips are never part of sales.

## Order & kitchen state
Order: `open → closed | void | merged` (reopen = audited supervisor action while the business day is open). Item: `draft → fired | held → accepted → preparing → ready → served | void`. Course 1 fires on *Send*; later courses (or items marked hold) wait as `held` until *Fire course*. Items without a station (`none`) are served immediately. Kitchen progress may continue after payment (quick service); prices and quantities never change once an order is closed (trigger `guard_closed_order_items`).

## Concurrency
- `SELECT … FOR UPDATE` on the order row serialises edits from several terminals.
- A partial unique index allows one open order per table; order numbers come from an upserted per-outlet/business-date counter (gapless under parallel opening — tested).
- Payments are *reserved* (pending rows count against the amount due) so parallel attempts can never exceed the bill; `UNIQUE (org_id, idempotency_key)` makes retries safe.
- Idempotent order mutations: the `Idempotency-Key` header stores the response in the same transaction as the work.

## Payments (three phases)
1. Reserve — validate and commit a **pending** payment. 2. Call the provider **outside** any DB transaction. 3. Finalize — record the provider's answer and close the order if settled. A payment can only become `succeeded` when the provider says so; a crash in between leaves a visible pending payment (listed under reconciliation exceptions) instead of money without a record. Cash is confirmed by the cashier and finalized in phase 1.

## Approvals ("four eyes")
`resolveApprover` — if the actor's role holds the permission it approves itself (still audited); otherwise a *different* employee with that permission **and** `approvals.grant` must enter their PIN. Failed approver PINs count toward lockout. Approver and actor are both stored in the audit log.

## Integration with Fluentra
Transactional outbox: events are inserted in the same transaction as the business change, then delivered by the dispatcher (lease + `SKIP LOCKED`, exponential backoff, dead-letter, manual resync). See [FLUENTRA_INTEGRATION.md](FLUENTRA_INTEGRATION.md).

## Realtime
SSE from PostgreSQL `LISTEN/NOTIFY` (tenant-filtered server-side) with a polling fallback; serverless hosts return 503 for the stream and clients poll (KDS every 3 s, floor every 8 s).

## Sessions
Opaque random tokens stored hashed. POS sessions are bound to an outlet, expire after the outlet's idle time (auto-lock, default 15 min) and 14 h absolute; back-office sessions idle out after 8 h. PIN/password failures lock the employee for 10 minutes after 5 attempts; all attempts are rate limited per IP and per employee.

## i18n
English text is the key; French is complete and test-enforced (100% coverage, no dead keys). The layout switches `dir="rtl"` for Arabic and uses logical Tailwind properties, but the Arabic dictionary is **not written yet** (falls back to English).
