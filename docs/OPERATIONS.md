# Operations

## Deploy
Build: `npm ci && npm run build && npm start`. Run `npm run db:migrate` with `MIGRATION_DATABASE_URL` before starting a new version (never seed production). Set `APP_SECRET`, `CRON_SECRET`, `APP_URL`, SMTP variables, and leave `DEV_SIMULATE_NOTIFICATIONS` off. A `Dockerfile` and `docker-compose.yml` are provided but **have not been built or run** in the authoring environment (no Docker daemon).

## Background jobs
Run one of: `npm run worker` (recommended), an external scheduler calling `POST /api/cron/tick` with header `Authorization: Bearer $CRON_SECRET` every minute, or `JOB_RUNNER_INLINE=true` for single-instance setups. Failed jobs retry with backoff; check the `jobs` table for `failed` rows.

## Backup and restore
`npm run db:backup` writes a timestamped `pg_dump` custom-format file; `scripts/restore.sh <file>` restores into a target database. Backup and restore were verified end to end locally. Schedule backups and test restores regularly; uploaded files (`UPLOAD_DIR`) must be backed up separately.

## Monitoring
`GET /api/health` checks database connectivity. Logs are structured JSON on stdout (`src/lib/logger.ts`). Audit events are in `audit_logs` and visible to owners in the UI.

## Security checklist
Use a non-superuser `DATABASE_URL`; terminate TLS in front of the app; rotate `APP_SECRET`/`CRON_SECRET` knowing it invalidates outstanding public links; restrict `/api/cron/tick` and `/api/webhooks/*` at the proxy if possible.
