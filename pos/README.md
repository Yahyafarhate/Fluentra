# Comptoir — restaurant POS

Comptoir is a **separate product** from Fluentra (the reservation & guest-management SaaS in the repository root). It is a restaurant point of sale — floor plan, order taking, kitchen display, bills and payments, cash drawers, reports — that integrates with Fluentra through a documented, signed event contract and **never depends on Fluentra being online**. "Comptoir" is a working name; the UI and code are original.

Stack: Next.js 16 (App Router) · TypeScript · Tailwind 4 · PostgreSQL 16 (raw SQL migrations, Row Level Security) · Zod · Vitest. Same stack and conventions as Fluentra, own database and own deployment.

> Read [docs/STATUS.md](docs/STATUS.md) first: it states exactly what is implemented and tested, what is partial, and what is not built (offline mode, real payment terminals, printers, inventory, fiscal compliance…). Nothing is claimed as working there unless it is implemented and covered by a test or by the browser journey.

## Quick start

Requirements: Node ≥ 20 and PostgreSQL 16 with an owner account that can create roles.

```bash
cd pos
cp .env.example .env            # DATABASE_URL (non-superuser role!), MIGRATION_DATABASE_URL, CRON_SECRET
npm install
npm run db:reset                # drop → migrate → demo seed (development only)
npm run dev                     # http://localhost:3100
```

`DATABASE_URL` must use the non-superuser role `comptoir_app` (created by the migration runner) — otherwise Row Level Security would be bypassed. The migration runner refuses to continue if that role is a superuser or can bypass RLS.

### Demo data (development only — never seed production)

| Entry point | Credentials |
|---|---|
| Back office `/admin/login` | `owner@atlas.demo` / `Demo-Pass-2026` |
| POS `/pos/login` | terminal code printed by `db:reset` (also shown in Back office → Floor); pick a name, then PIN |
| PINs | owner 2468 · manager Salma 3579 · supervisor Youssef 4680 · cashier Nadia 5791 · server Omar 6802 · bartender Imane 7913 · kitchen Hamza 8024 |
| KDS `/kds` | sign in as kitchen (or any role with the KDS permission) |

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js on port 3100 |
| `npm run lint` / `typecheck` | ESLint / `tsc --noEmit` |
| `npm test` | Vitest suite (creates/drops its own `comptoir_test` database) |
| `node tests/e2e/journey.mjs` | Browser journey against a running, freshly seeded dev server (needs Chromium: `CHROMIUM_PATH` or `/opt/pw-browsers/chromium`) |
| `npm run db:migrate` / `db:reset` | Schema / drop+migrate+seed (dev only) |
| `npm run docs:api` | Regenerate `docs/API.md` from the route table |

## Layout

```
migrations/      schema, RLS policies, immutability triggers
scripts/         migrate, seed (dev), reset, api-doc generator, i18n coverage
src/lib/         db (tenant-scoped transactions), auth (PIN + password, approvals), rbac, money, api helpers
src/server/      orders (+ pure totals engine), kitchen, payments (+ provider contract), cash, reports,
                 integration (outbox, adapters, dispatcher), menu, outlets, staff, routes
src/app/         /pos (floor, order, orders, cash, receipt), /kds, /admin/*, /api/*
tests/           Vitest suites + tests/e2e/journey.mjs
docs/            ARCHITECTURE, FLUENTRA_INTEGRATION, METRICS, OPERATIONS, STATUS, HARDWARE_AND_COMPLIANCE, API
```

## Tests

`npm test` — 36 tests in 5 files: money/tax arithmetic, end-to-end service flow with reports that reconcile, authorization/approvals/refunds/reopen/day-close/cash/menu/PIN lockout/idle lock/CSRF, concurrency and idempotency, provider-confirmation rules, the Fluentra outbox (mock adapter, signed HTTP adapter, Fluentra down, resync/backfill, data minimisation), tenant isolation at API/service/database level, database-enforced immutability, and 100% French translation coverage. `tsc`, ESLint and `next build` are clean.

## Deploying

See [docs/OPERATIONS.md](docs/OPERATIONS.md) (own database; Vercel + Neon notes, cron/outbox, backups). The repository root is a Fluentra Next.js app too: when deploying this POS on Vercel, set the project's **Root Directory** to `pos`.
