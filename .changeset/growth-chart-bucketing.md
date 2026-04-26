---
"@onesub/shared": patch
"@onesub/server": patch
---

Add daily bucketing to the metrics endpoints — backs the dashboard's growth chart.

**Server**

- `GET /onesub/metrics/started` and `GET /onesub/metrics/expired` accept an optional `groupBy=day` query param. When set, the response includes a `buckets: { date, count }[]` array — one entry per UTC calendar day in the window, zero-filled, sorted ascending.
- Without `groupBy` the response shape is unchanged (backwards compatible).

**Shared**

- New `MetricsBucket` type and `MetricsGroupBy` union (`'none' | 'day'`).
- `MetricsCountResponse.buckets?` optional field.
