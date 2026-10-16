# Feature status

"Complete" means implemented and covered by an automated test or the E2E journey. Verified on this branch: 96 Vitest tests passing, `tsc` and ESLint clean.

## Completed
- Multi-tenancy with forced RLS, composite FKs, tenant-isolation tests; RBAC for 7 roles (matrix tested)
- Auth: signup, login, lockout, reset, invites, DB rate limiting, CSRF origin check
- Availability engine and transactional booking with advisory lock + GiST exclusion; concurrency tests
- Reservation lifecycle, walk-ins, early seating, moving a seated party to another table (old table → awaiting cleaning), table conflicts, audit log
- Table grouping for parties bigger than the largest table: nearest free tables on the same floor (fewest wasted seats), guest opt-in on the booking page, online bookings stay pending until staff validate, validator can pick any tables by hand (tested; the distance uses floor-plan positions, there is no adjacency/walls model)
- Floor plan editor, live floor, timeline, sections, table combinations
- Waitlist with public join/status pages and promotion to reservation
- CRM: profiles, tags, notes, consent ledger, search, merge, GDPR-style export/erase
- Notifications engine, templates (FR/AR/EN), automations (idempotent), campaigns with honest metrics, SMTP delivery
- Analytics with CSV export; dashboard from real data; SSE live updates
- Settings, team management, plan limits enforcement, super-admin portal with safe suspension
- Public booking site (FR/AR/EN, RTL), manage/cancel links, feedback, unsubscribe
- Seed data, migrations, backup/restore scripts, API docs generator, CI workflow
- FR/AR translation with 100% coverage test; RTL verified visually

## Partial
- Twilio / WhatsApp adapters: written, unverified live
- Webhook delivery receipts: signature verification tested, no real provider
- Docker / compose: provided, never built here
- Billing: plan and limit enforcement real; payments simulated
- Responsive UI: desktop, tablet icon-rail and main screens checked; not every screen audited on mobile

## Pending / known limitations
- No payment provider (deposits are pending-only), no POS integration
- File storage is local disk (S3-compatible storage pending)
- No 2FA, no email verification, no session-management UI, no impersonation
- Special menus/events on the public page not implemented
- Services cannot span midnight
- Closing a special day does not auto-cancel existing reservations
- API error messages and the super-admin portal are English only
- Table combinations are explicit definitions, not computed adjacency
- Brand name is temporary
