# Fluentra integration

## Status — read this first
| Piece | State |
|---|---|
| POS-side event contract (v1), transactional outbox, dispatcher, retries, dead-letter, resync/backfill, sharing permissions | **Implemented and tested** |
| `mock` adapter (writes to a local `mock_fluentra_inbox` table) | Implemented — **a test environment, never a live integration**; the UI labels it MOCK |
| `http` adapter (signed HTTPS POST) | Implemented and tested against a local HTTP server (signature, 5xx retry, 4xx dead, 409 = already delivered) — **not verified against a live Fluentra** |
| Fluentra side | **Does not exist yet.** Fluentra (as inspected in this repository) has *no* endpoint that ingests POS events: its only inbound webhook is `/api/webhooks/delivery` (message delivery receipts). Revenue in Fluentra is currently recorded manually on visits. Nothing in this document is an existing Fluentra API. |

## Principles
- Comptoir is the **authority for transactions**; Fluentra only receives confirmed, immutable facts.
- A sale never waits for Fluentra: events are written to the outbox in the same transaction as the sale and delivered in the background. Fluentra down ⇒ events queue and retry (tested: orders keep closing while the adapter fails).
- Data minimisation: no guest personal data is part of any event (the POS holds none). Per organization the owner chooses what may leave: sales/payments/cash/day-close, item lines, refunds & voids, kitchen delays. Events that are not shared are marked `skipped`.

## Wire format
`POST <configured URL>` with `Content-Type: application/json`

Headers: `X-Comptoir-Event-Id` (= `Idempotency-Key`), `X-Comptoir-Timestamp` (unix seconds), `X-Comptoir-Signature: sha256=<hex>` where the signature is `HMAC-SHA256(secret, "<timestamp>.<raw body>")`. The secret is `FLUENTRA_SHARED_SECRET` in the POS server environment (never in the database). Receivers should reject timestamps older than 5 minutes.

```json
{
  "specVersion": 1, "source": "comptoir-pos",
  "eventId": "uuid (stable across retries)", "type": "order.closed", "version": 1,
  "occurredAt": "ISO-8601", "organizationId": "uuid",
  "outlet": { "id": "uuid", "fluentraLocationId": "string|null" },
  "data": { … }
}
```

Receiver contract: respond `2xx` when stored, `409` if the `eventId` is already stored (treated as delivered), `5xx`/`408`/`429` to be retried, any other `4xx` makes the event `dead` (visible in the monitor; revive with *Re-queue failed*). De-duplicate on `eventId`.

## Events (version 1)
| type | when | `data` |
|---|---|---|
| `order.closed` | an order is fully paid (or zero-total closed) | `orderId, orderNo, businessDate, type, covers, openedAt, closedAt, currency, totals{gross,discount,serviceCharge,tax,netSales,total,tip}Cents, payments[{id,method,amountCents,tipCents}]`, `items[{productId,name,qty,unitPriceCents,discountCents}]` only if item sharing is on |
| `order.reopened` / `order.voided` | supervisor reopens (a new `order.closed` with the next revision follows) / voids | ids, reason, `businessDate` |
| `payment.recorded` | a provider-confirmed or cash payment succeeds | `paymentId, orderId, method, provider, amountCents, tipCents, currency` |
| `refund.recorded` | an approved refund succeeds | `refundId, orderId, amountCents, reason, method` |
| `item.voided` | a sent item is voided | `orderId, itemId, name, qty, amountCents, reason` |
| `cash_session.closed` | a drawer is counted and closed | `expected/counted/variance Cents` |
| `day.closed` | the business day is closed | `orders, covers, totalCents, netSalesCents, refundsCents, reconciled` |
| `kitchen.delay` | an item was ready later than the station target | `station, targetSeconds, actualSeconds` |

Ordering: events carry `occurredAt`; delivery is in insertion order per dispatcher run but receivers must not rely on strict ordering across retries.

## Mapping
`outlets.fluentra_location_id` (Back office → Settings) maps a POS outlet to its Fluentra location; organization mapping is implicit in the configured endpoint/secret.

## Monitoring & recovery (Back office → Fluentra sync)
Counts by state (pending/delivered/dead/skipped), oldest waiting event, recent errors, *Deliver now*, *Re-queue failed + backfill* for a date range (re-delivers; creates `order.closed` events for orders closed before the integration was enabled, flagged `backfilled: true`).

## What Fluentra must provide (proposal, to be agreed — nothing below exists)
1. An authenticated ingestion endpoint implementing the receiver contract above, storing events in an idempotent table keyed by `eventId`.
2. A mapping from `fluentraLocationId` to its `locations`.
3. A decision on how POS sales attach to guests: the POS has no guest identity, so linking an order to a reservation/visit requires an explicit reference captured at table opening (e.g. the Fluentra reservation id) — **not implemented in the POS yet**.
4. Which Fluentra metrics should use POS revenue instead of manually recorded spend (Fluentra's own rule: revenue is never estimated).
