# Report definitions

Principle: every figure comes from **closed orders** (their immutable snapshot) and **recorded payments/refunds**. Nothing is estimated. All amounts are integer centimes.

| Term | Definition |
|---|---|
| Business date | The outlet-local date the order was **opened**, shifted by the outlet's "business day starts at" hour (default 05:00). An order belongs to one business date even if it closes after midnight. Refunds belong to the business date on which they are issued. |
| Gross | Σ quantity × unit price (modifiers included), before any discount |
| Discounts | item discounts + order discounts (order discounts are spread over lines by largest remainder) |
| Service charge | percentage of the discounted items (outlet setting) |
| Tax | per rate group; prices-include-tax: `gross × r/(1+r)`; otherwise `base × r` |
| Net sales | items after discounts, **excluding** tax and service charge |
| Total billed | items after discounts + service charge (+ tax when prices exclude tax). Tips excluded |
| Tips | recorded on the payment, never part of sales; cash tips stay in the drawer and are counted in expected cash |
| Average check | total billed ÷ closed orders |
| Average per cover | total billed ÷ covers, over all closed orders (orders without covers contribute 0 covers; the UI says so) |
| Refunds | succeeded refunds in the period; "net of refunds" = total billed − refunds |
| Voids | sent items voided (not unsent removals), and voided orders; both list reason, employee and approver |
| Table metrics | dine-in orders with a table: turns, covers, total, average minutes from open to close |
| Product/category sales | gross item lines (before order-level discounts, service charge and tax) |

## Reconciliation
`Reports → Reconciliation` proves, per period, that the billed total of closed orders equals the succeeded payments applied to them (and tips equal tips), and lists exceptions: orders that do not match, pending payments older than 5 minutes, declined payments, failed refunds, cash-drawer variances. Tests assert this for a split-bill service.

## Expected cash
`opening float + cash payments (applied amount) + cash tips + pay-ins − pay-outs − cash refunds`. Change given is never counted (only the applied amount is). Variance = counted − expected.
