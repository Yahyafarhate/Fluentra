# Metrics definitions

Principle: show only what is measured; label estimates; never fabricate revenue.

| Metric | Definition |
|---|---|
| Covers | Sum of party sizes of reservations in the period, by status filter shown in the UI |
| Revenue | Sum of **recorded** spend (entered at completion, or from a future POS). Reservations without recorded spend contribute nothing; the UI says how many lack spend. |
| Estimated revenue | Covers × a user-configured average spend, always labelled "Estimate" |
| No-show rate | no_show ÷ (completed + seated + no_show) |
| Cancellation rate | cancelled ÷ all non-pending reservations in period |
| Occupancy / utilisation | Seated minutes ÷ available table-minutes in service windows |
| Source mix | Reservation `source` (online, phone, walk-in, staff…) |
| Campaign delivery | Notifications with status `sent` ÷ recipients (simulated and skipped are counted separately and never as delivered) |
| Campaign engagement | Tracked opens/clicks where the channel supports them (email opens are unreliable and labelled so) |
| Attributable bookings | Reservations created by a guest within the attribution window after a *sent* campaign message to that guest; labelled "attributed", not "caused" |

CSV exports contain the same figures as the screens.
