-- @onesub/server — canonical Postgres schema
--
-- This file is the single source of truth for the database schema used by
-- `PostgresSubscriptionStore` and `PostgresPurchaseStore`.
--
-- How it's applied:
--   1. Automatically: `store.initSchema()` executes the same DDL at runtime
--      (embedded in packages/server/src/stores/postgres.ts). A parity test
--      asserts the two stay in sync.
--   2. Manually: `psql $DATABASE_URL -f packages/server/sql/schema.sql`
--   3. Via docker-compose: mounted into
--      `/docker-entrypoint-initdb.d/` so a fresh Postgres container
--      bootstraps automatically on first boot.
--
-- All statements are idempotent (`IF NOT EXISTS`) and safe to re-run.

-- ─── Subscriptions (auto-renewable) ──────────────────────────────────────────
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

-- Backfill columns for installs that already created the table from an older
-- schema. Safe to re-run.
ALTER TABLE onesub_subscriptions ADD COLUMN IF NOT EXISTS linked_purchase_token TEXT;
ALTER TABLE onesub_subscriptions ADD COLUMN IF NOT EXISTS auto_resume_time TIMESTAMPTZ;

-- ─── One-time purchases (consumable + non-consumable) ────────────────────────
-- `transaction_id` is the primary key: enforces one row per Apple/Google
-- transaction, which is what makes receipt-reuse across users detectable
-- (see @onesub/server@0.5.0 — TRANSACTION_BELONGS_TO_OTHER_USER).
--
-- The partial unique index on (user_id, product_id) WHERE type = 'non_consumable'
-- enforces "purchased once" semantics for non-consumables while still
-- allowing consumables (coins, credits) to accumulate rows per user.
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
