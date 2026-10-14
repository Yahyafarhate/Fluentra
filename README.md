# Fluentra

Multi-tenant restaurant reservation and guest-management SaaS, adapted to Morocco and international markets (FR / AR with RTL / EN). "Fluentra" is a temporary working brand name.

Stack: Next.js 16 (App Router) · TypeScript · Tailwind 4 · PostgreSQL 16 (raw SQL migrations, Row Level Security) · Zod · Vitest.

> Read [docs/STATUS.md](docs/STATUS.md) first for exactly what is complete, partial and pending. Nothing is claimed as working there unless it is implemented and covered by a test or the E2E journey.

## Quick start

Requirements: Node >= 20, PostgreSQL 16 reachable with an owner (superuser or CREATEROLE) account.

```bash
cp .env.example .env        # edit DATABASE_URL, MIGRATION_DATABASE_URL, APP_SECRET (>= 32 chars)
npm install
npm run db:reset            # drop -> migrate -> seed demo data
npm run dev                 # http://localhost:3000
```

`DATABASE_URL` is the runtime connection and must use the non-superuser role `fluentra_app` (created by the migration runner), otherwise Row Level Security would be bypassed. `MIGRATION_DATABASE_URL` is the owner connection used by migrations and seed only.

### Demo accounts

All demo accounts use the password `Demo-Pass-2026` (development seed only).

| Account | Role |
|---|---|
| admin@fluentra.dev | Platform super admin (`/admin`) |
| owner@atlas.demo | Owner, tenant "Atlas Hospitality Group" (2 locations) |
| gm@atlas.demo | General manager |
| manager@atlas.demo | Restaurant manager (one location) |
| host@atlas.demo | Host |
| service@atlas.demo | Service |
| marketing@atlas.demo | Marketing manager |
| owner@medina.demo | Owner of a second tenant, "Café Médina SARL" (isolation checks) |

Public booking pages for the seeded restaurants: `/book/le-riad-atlas`, `/book/skyline-rooftop`, `/book/cafe-medina`.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run lint` / `typecheck` | ESLint / `tsc --noEmit` |
| `npm test` | Vitest suite (needs the database; creates and drops its own test DB) |
| `npm run test:e2e` | Playwright-driven browser journey against a running dev server |
| `npm run db:migrate` / `db:seed` / `db:reset` | Schema and demo data |
| `npm run db:backup` | `pg_dump` backup (`scripts/restore.sh` restores) |
| `npm run worker` | Standalone background job runner |
| `npm run i18n:check` | Report missing FR/AR translations |
| `npm run docs:api` | Regenerate `docs/API.md` from the route table |

## Environment variables

See `.env.example` (every variable is commented). Key ones: `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `APP_SECRET`, `CRON_SECRET`, `SMTP_*` (real email), `DEV_SIMULATE_NOTIFICATIONS`, `JOB_RUNNER_INLINE`, `UPLOAD_DIR`. No secret is committed.

## Directory structure

```
migrations/        SQL schema, RLS policies, seeded plans
scripts/           migrate, seed, reset, worker, backup/restore, doc generators
src/lib/           db, auth, rbac, tz, i18n, rate limiting, audit, API helpers
src/server/        domain services (availability, reservations, floor, waitlist,
                   customers, notifications, automation, marketing, analytics,
                   billing, tenants, admin) + declarative route tables
src/app/           pages and API catch-all handlers
src/components/    UI kit, shell, forms, drawers
tests/             Vitest suites + tests/e2e/journey.mjs
docs/              ARCHITECTURE, METRICS, OPERATIONS, INTEGRATIONS, STATUS, API
```

## Data model overview

`organizations` (tenant) → `locations` → `sections`, `tables`, `table_combinations`, `services`, `special_days`, `reservations` (+ `reservation_tables` with a GiST exclusion constraint), `waitlist_entries`. Guests: `customers`, `consents` (append-only ledger), tags, notes. Messaging: `notifications`, `automation_rules`, `automation_runs`, `campaigns`, `campaign_recipients`. Platform: `users`, `memberships`, `sessions`, `plans`, `subscriptions`, `audit_logs` (append-only), `jobs`, `rate_limits`. Every tenant table carries `org_id`, has RLS forced, and cross-references use composite `(id, org_id)` foreign keys.

## Tests

`npm test` runs 96 tests in 11 files: availability engine, reservation state machine, concurrency (12 simultaneous bookings → exactly one wins; DB-level exclusion guard), tenant isolation (DB, service and API), auth and lockout, RBAC matrix, public booking, integrations (including a real SMTP adapter against an in-process SMTP server), workflows (waitlist, automations, merge, marketing), sections, and 100% FR/AR translation coverage.

Last full run on this branch: 11 files, 96 tests passed; `tsc` and ESLint clean.

## Troubleshooting

- **Everything visible across tenants / RLS tests fail**: `DATABASE_URL` points at a superuser. Use the `fluentra_app` role.
- **`permission denied` on migrate**: `MIGRATION_DATABASE_URL` needs CREATEROLE/owner rights.
- **Times off by one hour**: all timezone math is done in PostgreSQL; check the location timezone in Settings and the server's Postgres tzdata.
- **No emails arrive**: without `SMTP_HOST` messages are recorded as `SIMULATED` (dev) or `skipped`, never `sent`. Use Mailpit locally (`SMTP_HOST=localhost SMTP_PORT=1025`).
- **Background jobs idle**: set `JOB_RUNNER_INLINE=true`, run `npm run worker`, or POST `/api/cron/tick` with `CRON_SECRET`.
