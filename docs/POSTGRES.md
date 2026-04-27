# Running onesub on Postgres

This guide covers production operation of the Postgres-backed stores
(`PostgresSubscriptionStore`, `PostgresPurchaseStore`).

## Schema

`initSchema()` creates the tables and indexes from
[packages/server/sql/schema.sql](../packages/server/sql/schema.sql). DDL is
idempotent (every `CREATE` uses `IF NOT EXISTS`), so it's safe to call on
every boot.

For environments where DBAs gate DDL, run the SQL file manually instead:

```bash
psql $DATABASE_URL -f packages/server/sql/schema.sql
```

## Indexes

All shipped indexes:

| Table                  | Index                                       | Used by                                  |
|------------------------|---------------------------------------------|------------------------------------------|
| onesub_subscriptions   | `idx_onesub_subscriptions_user_id (user_id, updated_at DESC)` | `getByUserId`, `getAllByUserId`        |
| onesub_subscriptions   | `idx_onesub_subscriptions_status_updated (status, updated_at DESC)` | `listFiltered` with `status` filter |
| onesub_subscriptions   | `idx_onesub_subscriptions_platform_updated (platform, updated_at DESC)` | `listFiltered` with `platform` filter |
| onesub_subscriptions   | `idx_onesub_subscriptions_product (product_id, updated_at DESC)` | `listFiltered` with `productId` filter |
| onesub_purchases       | `idx_onesub_purchases_user_id (user_id, purchased_at DESC)` | `getPurchasesByUserId`                |
| onesub_purchases       | `idx_onesub_purchases_user_product (user_id, product_id)` | `hasPurchased`, `deletePurchases`     |
| onesub_purchases       | `idx_onesub_purchases_non_consumable (user_id, product_id) WHERE type = 'non_consumable'` | enforces single non-consumable per user/product |

The dashboard's filtered list uses `updated_at DESC` ordering across every
filter combination — partial indexes per filter column keep the planner from
falling back to a sort on the full table once row counts climb.

## Sizing & vacuum

Subscription rows are upserted on every webhook (`updated_at` rewrites). On
a busy product expect `pg_stat_user_tables.n_dead_tup` to grow steadily;
let autovacuum run.

For tables exceeding ~1M rows consider:

```sql
ALTER TABLE onesub_subscriptions SET (autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE onesub_purchases     SET (autovacuum_vacuum_scale_factor = 0.05);
```

This trims the bloat threshold from the default 20% to 5%, which keeps
`updated_at DESC` index scans on the hot path fast.

## Connection pool

`PostgresSubscriptionStore` opens a pool with `max: 10` by default. For a
fleet of ~4 web nodes serving ~100 req/s each, raise to `max: 25` and
configure pgBouncer in transaction mode:

```js
new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 25,
  idleTimeoutMillis: 30_000,
});
```

If you need a custom pool (auth proxy, statement timeout, SSL), bring your
own `pg.Pool` and wrap the store — the constructor accepts a
`connectionString` today; if you need pool injection, open an issue.

## Read replicas

Reads dominate the workload (status checks, dashboard queries). To route
those to a replica without forking the store:

```js
const writeStore = new PostgresSubscriptionStore(process.env.DATABASE_URL_PRIMARY);
const readStore  = new PostgresSubscriptionStore(process.env.DATABASE_URL_REPLICA);

// Use readStore for the status route by passing it via createStatusRouter
// directly; route writes (validate, webhooks) through writeStore.
```

## Backups

Every record is reconstructable from Apple's App Store Server API and
Google Play Developer API given the original transaction id, so a 24-hour
PITR window is usually enough. Critical to back up:

- `onesub_purchases` — non-consumable ownership, can't be recovered without
  the original platform receipt
- `onesub_subscriptions` — convenience store; can be rebuilt from webhooks
  + `fetchAppleSubscriptionStatus` / Google Play API

## Migrating to Postgres from in-memory

The in-memory store is process-local, so no migration is required — just
deploy with `DATABASE_URL` set. Existing subscriptions will reappear when
their next webhook fires (Apple sends `RENEWAL` at every cycle; Google
delivers RTDN on every state change). For users without a recent webhook,
trigger a forced refresh by calling `fetchAppleSubscriptionStatus()` /
the Google purchases API once per active subscriber during the migration
window.
