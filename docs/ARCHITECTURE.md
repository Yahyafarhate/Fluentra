# Architecture

## Layers
`src/app` (pages, thin API handlers) → `src/server/routes` (declarative `Router`; each route declares a permission string, docs are generated from it) → `src/server/<domain>` services → `src/lib/db` (transactions, per-transaction tenant context).

## Tenant isolation (defence in depth)
1. **Database**: every tenant table has `org_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, and policies using `app_org()` / `app_system()`, read from `set_config('app.org_id' | 'app.system', …, true)` set at the start of each transaction by `withOrg()` / `withSystem()`. The runtime role `fluentra_app` is non-superuser and non-owner, so RLS cannot be bypassed by the app.
2. **Referential**: composite foreign keys `(id, org_id)` make cross-tenant references impossible even for a buggy insert.
3. **Service/API**: the session resolves to a `Ctx` (user, org, membership, location scope). Permissions are checked server-side per route; location-scoped roles are restricted to their locations.
4. **Tests** (`tests/tenant-isolation.test.ts`) attack each layer: raw SQL without context, forged ids across tenants, API calls with another tenant's ids.
Suspended organisations are blocked at the auth layer; the public site returns a neutral unavailable response.

## Availability and booking engine
`availability/engine.ts` is a pure function: service windows, special days, pacing, party limits, turn-time by party size, table fit (including explicit table combinations and optional section restriction) and existing occupancy → slots. `service.ts` loads data and calls it.

Booking is transactional: take a per-location `pg_advisory_xact_lock`, recompute availability inside the transaction, insert the reservation and `reservation_tables` rows. A GiST exclusion constraint on `(table_id, during)` is the final guard; a violation maps to `409 TABLE_CONFLICT`. Concurrency tests prove one winner out of 12 parallel attempts and that the constraint holds when the application check is bypassed.

## Time
Postgres is the single source of truth for timezone conversion (`src/lib/tz.ts`) because Node ICU and system tzdata disagreed on `Africa/Casablanca`. Reservations store `timestamptz`; the location timezone is applied in SQL.

## Reservation workflow
`reservations/state.ts` defines allowed transitions (pending → confirmed → seated → completed; cancelled / no_show; etc.). Seating shifts the table range to "now" and fails with `TABLE_BUSY_UNTIL` if the table is still occupied. Every transition writes an audit log entry and may enqueue automations.

## Background work
`jobs` table, claimed with `FOR UPDATE SKIP LOCKED`, exponential backoff, idempotency keys. Runners: inline (dev), `npm run worker`, or `POST /api/cron/tick` (secret-protected). Automations create idempotent `automation_runs`; notifications go through adapters (email SMTP, Twilio SMS, WhatsApp Cloud). With no provider, messages are labelled `simulated` (dev only) or `skipped` — never `sent`.

## Auth and security
Password hashing with bcrypt, hashed session tokens, HttpOnly SameSite cookies, account lockout, DB-backed rate limiting, CSRF via Origin check on every mutating cookie-authenticated route, HMAC tokens for reservation-manage and unsubscribe links, security headers (CSP, XFO, nosniff, HSTS in production), upload type/size validation, append-only audit and consent ledgers (UPDATE/DELETE revoked from the app role).

## Realtime
SSE endpoint fed by Postgres `LISTEN/NOTIFY`, with client polling fallback.

## Plans
`plans` define limits and feature flags; `billing/limits.ts` enforces them server-side (locations, users, campaigns, features). Billing is simulated: there is no payment provider.

## i18n
English text is the translation key; `fr` and `ar` dictionaries are checked for 100% coverage by a test. RTL uses logical Tailwind properties. The super-admin portal and API error messages stay English.
