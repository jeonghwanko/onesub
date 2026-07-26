---
'@onesub/server': minor
---

Push metrics aggregation into SQL instead of reducing every row in the process.

Each `/onesub/metrics/*` request read the entire subscription or purchase table and
reduced it on the event loop, where it competes with receipt validation. Caching
(0.20.0) bounded how often that happened; it did not make the scan cheaper.

`SubscriptionStore` and `PurchaseStore` gain optional aggregate methods —
`aggregateActive`, `aggregateStarted`, `aggregateExpired`,
`aggregateNonConsumable` — and the metrics routes use them when the store has one.
The Postgres stores implement them as `GROUP BY`, so the work is bounded by
products × platforms (× days when bucketing) rather than by row count.

Optional, so nothing breaks: a store without them falls back to the previous
`listAll()` plus in-memory reduction, which is the path the in-memory and Redis
stores keep. Neither has server-side grouping to push into, so implementing there
would be the same reduction behind a longer interface. Custom stores written before
these methods existed keep working unchanged. `/onesub/metrics/active` takes each
half independently, so a Postgres subscription store pairs fine with a custom
purchase store.

`metrics-aggregate.ts` remains the definition of what the numbers mean, and is now
what the SQL is checked against: `postgres-store.test.ts` runs both paths over the
same rows and asserts the results are identical — inclusive window bounds, the
strictly-greater-than expiry boundary, status and type filters, and zero-filled
UTC calendar-day buckets.

One correctness note worth stating, because a green CI would not have caught it.
`date_trunc` truncates in the database session's timezone, so the daily buckets are
only correct because of an explicit `AT TIME ZONE 'UTC'` cast. A CI container
running UTC cannot distinguish that from a missing cast — every other test passes
either way — so one test forces a non-UTC session on its own connection and
re-checks the equivalence there.
