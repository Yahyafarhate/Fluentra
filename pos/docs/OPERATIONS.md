# Operations

## Environment (`.env.example`)
`DATABASE_URL` (non-superuser `comptoir_app`), `MIGRATION_DATABASE_URL` (owner, migrations/seed only), `APP_DB_PASSWORD`, `CRON_SECRET`, `POS_ENABLE_TEST_PAYMENTS` (**off in production**: card payments then fail with `PROVIDER_NOT_CONFIGURED` because no real provider exists), `FLUENTRA_SHARED_SECRET`, `TRUST_PROXY`, `POS_ALLOW_SIGNUP` (self-service organization creation is disabled in production unless `true`).

## Deploy
`npm ci && npm run build && npm start` (port 3100) after `npm run db:migrate` with the owner URL. Never run `db:reset`/`db:seed` in production (both refuse when `NODE_ENV=production`).

**Vercel + Neon** — same recipe as Fluentra: create a *separate* Neon database, run migrations from a trusted machine or CI with the direct (non-pooler) owner URL, give Vercel the pooled URL of the `comptoir_app` role, set the project **Root Directory** to `pos`, set `TRUST_PROXY=true`. On serverless hosts the SSE stream is disabled (clients poll) and the pool is limited to 3 connections. **Not deployed or tested on Vercel/Neon from this environment.**

## Outbox delivery
Events are delivered by `kickOutbox()` after each commit (non-serverless) and by `GET|POST /api/cron/tick` with `Authorization: Bearer $CRON_SECRET` — schedule it every minute (Vercel Hobby only allows daily crons: use an external scheduler such as a GitHub Actions schedule). Backlog and errors are visible in Back office → Fluentra sync.

## Backups
The database is the single source of truth (orders, payments, audit, outbox). Use `pg_dump` on the schedule your RPO requires and test restores; the `audit_logs` table is append-only for the application role. Image/file storage is not used.

## Monitoring
`GET /api/health` (database check). Structured JSON logs; secrets and PII-like keys are redacted by `src/lib/logger.ts`. Reconciliation exceptions (pending payments, mismatches, variances) are the financial alerts to watch daily; there is no alerting integration yet.

## Security checklist
Non-superuser DB role; TLS in front of the app; rotate `CRON_SECRET`/`FLUENTRA_SHARED_SECRET` on staff changes; keep `POS_ENABLE_TEST_PAYMENTS` off; restrict `/api/cron/tick` at the proxy if possible. Cookies are HttpOnly + SameSite=Lax (+ Secure in production) and mutations need a same-origin `Origin`.
