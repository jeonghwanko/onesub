---
'@onesub/shared': minor
'@onesub/server': minor
---

Bound how often the metrics endpoints scan the store, and make their aggregation
testable.

Every `/onesub/metrics/*` endpoint reduces every record in the subscription or
purchase store. The dashboard overview calls four of them per render and opts out
of client-side fetch caching, so an uncached deployment re-scanned both tables on
every browser refresh, by every operator — with the reduction running
synchronously on the event loop, where it competes with receipt validation.

Aggregate responses are now cached for `metricsCacheTtlSeconds` (new config
field, default `30`, `0` disables). Cache keys are snapped onto the TTL grid
because the dashboard sends `to = new Date()` at millisecond precision, which
would otherwise make every request a unique key; the response still echoes the
caller's own `from`/`to`, so a client always sees the window it asked about.
Concurrent misses on one key collapse into a single computation.

The cache is private to each middleware instance rather than shared through the
`cache` adapter. A metrics key describes "every record in this store" and cannot
discriminate one store from another, so sharing would let two middlewares in one
process — or two deployments pointed at one Redis database — read each other's
totals for any window that happened to match. The trade-off is that a K-process
deployment recomputes up to K times per window instead of once, which is still a
fixed bound where there previously was none.

Nothing that decides entitlement is cached: `/onesub/status`,
`/onesub/entitlement(s)`, and both validate routes are untouched.

The reduction itself moved into `metrics-aggregate.ts` as pure functions. It had
been duplicated across four handlers — each re-implementing the same window
filter, product/platform tallies, and zero-filled UTC daily bucketing — and was
unreachable by a test without an HTTP server. Responses are unchanged; the
semantics now have direct coverage, including the inclusive window bounds and
UTC bucket assignment, which is what a future SQL-side aggregation will have to
reproduce.

Per-request aggregation is still one full store read, so pushing the aggregation
down into SQL remains worthwhile for large Postgres deployments. That needs
per-store support and is not included here.
