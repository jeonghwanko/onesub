/**
 * Embedded Postgres DDL mirrored from `packages/server/sql/schema.sql`.
 *
 * The `.sql` file is the single human-facing source of truth (mounted into
 * docker-entrypoint-initdb.d, runnable via `psql -f`, readable by DBAs).
 * These constants exist so that `initSchema()` can run without a filesystem
 * lookup after the package is bundled/installed.
 *
 * A test in `__tests__/schema.test.ts` asserts that the two stay in sync —
 * if you edit one, update the other (or the test will fail).
 */

export const SUBSCRIPTIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS onesub_subscriptions (
  original_transaction_id TEXT        PRIMARY KEY,
  user_id                 TEXT        NOT NULL,
  product_id              TEXT        NOT NULL,
  platform                TEXT        NOT NULL,
  status                  TEXT        NOT NULL,
  expires_at              TIMESTAMPTZ NOT NULL,
  purchased_at            TIMESTAMPTZ NOT NULL,
  will_renew              BOOLEAN     NOT NULL,
  linked_purchase_token   TEXT,
  auto_resume_time        TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onesub_subscriptions_user_id
  ON onesub_subscriptions (user_id, updated_at DESC);

-- Filter-helper indexes for /onesub/admin/subscriptions. Each filter column
-- is paired with updated_at DESC so the planner can serve "latest matching"
-- without sorting the full table once row count grows.
CREATE INDEX IF NOT EXISTS idx_onesub_subscriptions_status_updated
  ON onesub_subscriptions (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_onesub_subscriptions_platform_updated
  ON onesub_subscriptions (platform, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_onesub_subscriptions_product
  ON onesub_subscriptions (product_id, updated_at DESC);

-- Backfill columns for installs that already created the table from an older
-- schema. Safe to re-run.
ALTER TABLE onesub_subscriptions ADD COLUMN IF NOT EXISTS linked_purchase_token TEXT;
ALTER TABLE onesub_subscriptions ADD COLUMN IF NOT EXISTS auto_resume_time TIMESTAMPTZ;
`.trim();

export const PURCHASES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS onesub_purchases (
  transaction_id  TEXT        PRIMARY KEY,
  user_id         TEXT        NOT NULL,
  product_id      TEXT        NOT NULL,
  platform        TEXT        NOT NULL,
  type            TEXT        NOT NULL,
  quantity        INTEGER     NOT NULL DEFAULT 1,
  purchased_at    TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onesub_purchases_user_id
  ON onesub_purchases (user_id, purchased_at DESC);

CREATE INDEX IF NOT EXISTS idx_onesub_purchases_user_product
  ON onesub_purchases (user_id, product_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_onesub_purchases_non_consumable
  ON onesub_purchases (user_id, product_id)
  WHERE type = 'non_consumable';
`.trim();
