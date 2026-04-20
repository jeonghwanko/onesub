import type { SubscriptionInfo, PurchaseInfo } from '@onesub/shared';
import type { SubscriptionStore, PurchaseStore } from '../store.js';

/**
 * PostgreSQL-backed subscription store.
 *
 * Uses raw `pg` (node-postgres) to avoid Prisma / ORM dependencies.
 * The `pg` package must be installed separately:
 *
 *   npm install pg
 *   npm install -D @types/pg
 *
 * Usage:
 *   const store = new PostgresSubscriptionStore(process.env.DATABASE_URL!);
 *   await store.initSchema();
 *   app.use(createOneSubMiddleware({ ...config, store }));
 */
export class PostgresSubscriptionStore implements SubscriptionStore {
  // Lazy-loaded to avoid requiring `pg` unless this class is actually instantiated.
  private poolPromise: Promise<import('pg').Pool> | null = null;

  constructor(private readonly connectionString: string) {}

  private getPool(): Promise<import('pg').Pool> {
    if (!this.poolPromise) {
      this.poolPromise = (async () => {
        // Dynamic import so that `pg` is an optional peer dependency —
        // consumers who only use InMemorySubscriptionStore pay no cost.
        const pg = await import('pg').catch(() => {
          throw new Error(
            '[onesub] PostgresSubscriptionStore requires the `pg` package. ' +
              'Run: npm install pg'
          );
        });
        const Pool = pg.default?.Pool ?? (pg as unknown as { Pool: typeof import('pg').Pool }).Pool;
        return new Pool({ connectionString: this.connectionString, max: 10 });
      })();
    }
    return this.poolPromise;
  }

  /**
   * Creates the `onesub_subscriptions` table and indexes if they do not
   * already exist. Call this once during application startup.
   */
  async initSchema(): Promise<void> {
    const pool = await this.getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS onesub_subscriptions (
        original_transaction_id TEXT        PRIMARY KEY,
        user_id                 TEXT        NOT NULL,
        product_id              TEXT        NOT NULL,
        platform                TEXT        NOT NULL,
        status                  TEXT        NOT NULL,
        expires_at              TIMESTAMPTZ NOT NULL,
        purchased_at            TIMESTAMPTZ NOT NULL,
        will_renew              BOOLEAN     NOT NULL,
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_onesub_subscriptions_user_id
        ON onesub_subscriptions (user_id, updated_at DESC);
    `);
  }

  /**
   * Upserts the given subscription.
   * If a row with the same `original_transaction_id` already exists it is
   * updated in place; otherwise a new row is inserted.
   */
  async save(sub: SubscriptionInfo): Promise<void> {
    const pool = await this.getPool();
    await pool.query(
      `INSERT INTO onesub_subscriptions
         (original_transaction_id, user_id, product_id, platform, status,
          expires_at, purchased_at, will_renew, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (original_transaction_id) DO UPDATE SET
         user_id    = EXCLUDED.user_id,
         product_id = EXCLUDED.product_id,
         platform   = EXCLUDED.platform,
         status     = EXCLUDED.status,
         expires_at = EXCLUDED.expires_at,
         purchased_at = EXCLUDED.purchased_at,
         will_renew = EXCLUDED.will_renew,
         updated_at = NOW()`,
      [
        sub.originalTransactionId,
        sub.userId,
        sub.productId,
        sub.platform,
        sub.status,
        sub.expiresAt,
        sub.purchasedAt,
        sub.willRenew,
      ]
    );
  }

  /**
   * Returns the most recently updated subscription for the given user, or
   * `null` if no record exists.
   *
   * "Most recent" is determined by `updated_at DESC` so that the latest
   * status change is always returned when a user has multiple subscriptions.
   */
  async getByUserId(userId: string): Promise<SubscriptionInfo | null> {
    const pool = await this.getPool();
    const result = await pool.query<DbRow>(
      `SELECT *
         FROM onesub_subscriptions
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT 1`,
      [userId]
    );
    return result.rows.length > 0 ? rowToSubscriptionInfo(result.rows[0]) : null;
  }

  /**
   * Returns the subscription identified by `originalTransactionId` (the
   * table primary key), or `null` if it does not exist.
   */
  async getByTransactionId(txId: string): Promise<SubscriptionInfo | null> {
    const pool = await this.getPool();
    const result = await pool.query<DbRow>(
      `SELECT *
         FROM onesub_subscriptions
        WHERE original_transaction_id = $1`,
      [txId]
    );
    return result.rows.length > 0 ? rowToSubscriptionInfo(result.rows[0]) : null;
  }

  /** Gracefully close the underlying connection pool. */
  async close(): Promise<void> {
    if (this.poolPromise) {
      const pool = await this.poolPromise;
      await pool.end();
      this.poolPromise = null;
    }
  }
}

/**
 * PostgreSQL-backed purchase store for consumables and non-consumables.
 *
 * Uses raw `pg` (node-postgres). The `pg` package must be installed separately:
 *
 *   npm install pg
 *   npm install -D @types/pg
 *
 * Usage:
 *   const store = new PostgresPurchaseStore(process.env.DATABASE_URL!);
 *   await store.initSchema();
 *   app.use(createOneSubMiddleware({ ...config, purchaseStore: store }));
 */
export class PostgresPurchaseStore implements PurchaseStore {
  private poolPromise: Promise<import('pg').Pool> | null = null;

  constructor(private readonly connectionString: string) {}

  private getPool(): Promise<import('pg').Pool> {
    if (!this.poolPromise) {
      this.poolPromise = (async () => {
        const pg = await import('pg').catch(() => {
          throw new Error(
            '[onesub] PostgresPurchaseStore requires the `pg` package. ' +
              'Run: npm install pg'
          );
        });
        const Pool = pg.default?.Pool ?? (pg as unknown as { Pool: typeof import('pg').Pool }).Pool;
        return new Pool({ connectionString: this.connectionString, max: 10 });
      })();
    }
    return this.poolPromise;
  }

  /**
   * Creates the `onesub_purchases` table and indexes if they do not already exist.
   * Call this once during application startup.
   */
  async initSchema(): Promise<void> {
    const pool = await this.getPool();
    await pool.query(`
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
    `);
  }

  async savePurchase(purchase: PurchaseInfo): Promise<void> {
    const pool = await this.getPool();
    // transactionId is PRIMARY KEY. If the same transactionId already belongs
    // to a different userId we refuse the save — the second call is either a
    // fraudulent receipt-reuse attempt or a legitimate device migration that
    // should go through an explicit admin transfer instead. Returning silently
    // (the old ON CONFLICT DO NOTHING behavior) leaves the server reporting
    // valid:true while the DB has no row for the current user, which lets the
    // caller keep re-"buying" forever.
    const existing = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM onesub_purchases WHERE transaction_id = $1`,
      [purchase.transactionId],
    );

    if (existing.rows.length > 0) {
      const owner = existing.rows[0].user_id;
      if (owner !== purchase.userId) {
        const err = new Error('TRANSACTION_BELONGS_TO_OTHER_USER') as Error & { code?: string };
        err.code = 'TRANSACTION_BELONGS_TO_OTHER_USER';
        throw err;
      }
      // same user — idempotent no-op
      return;
    }

    await pool.query(
      `INSERT INTO onesub_purchases
         (transaction_id, user_id, product_id, platform, type, quantity, purchased_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        purchase.transactionId,
        purchase.userId,
        purchase.productId,
        purchase.platform,
        purchase.type,
        purchase.quantity,
        purchase.purchasedAt,
      ],
    );
  }

  async getPurchasesByUserId(userId: string): Promise<PurchaseInfo[]> {
    const pool = await this.getPool();
    const result = await pool.query<PurchaseDbRow>(
      `SELECT *
         FROM onesub_purchases
        WHERE user_id = $1
        ORDER BY purchased_at DESC`,
      [userId]
    );
    return result.rows.map(rowToPurchaseInfo);
  }

  async getPurchaseByTransactionId(txId: string): Promise<PurchaseInfo | null> {
    const pool = await this.getPool();
    const result = await pool.query<PurchaseDbRow>(
      `SELECT *
         FROM onesub_purchases
        WHERE transaction_id = $1`,
      [txId]
    );
    return result.rows.length > 0 ? rowToPurchaseInfo(result.rows[0]) : null;
  }

  async hasPurchased(userId: string, productId: string): Promise<boolean> {
    const pool = await this.getPool();
    const result = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM onesub_purchases
          WHERE user_id = $1 AND product_id = $2
       ) AS exists`,
      [userId, productId]
    );
    return result.rows[0]?.exists === true;
  }

  async deletePurchases(userId: string, productId: string): Promise<number> {
    const pool = await this.getPool();
    const result = await pool.query(
      `DELETE FROM onesub_purchases WHERE user_id = $1 AND product_id = $2`,
      [userId, productId]
    );
    return result.rowCount ?? 0;
  }

  /** Gracefully close the underlying connection pool. */
  async close(): Promise<void> {
    if (this.poolPromise) {
      const pool = await this.poolPromise;
      await pool.end();
      this.poolPromise = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface DbRow {
  original_transaction_id: string;
  user_id: string;
  product_id: string;
  platform: string;
  status: string;
  expires_at: Date;
  purchased_at: Date;
  will_renew: boolean;
}

function rowToSubscriptionInfo(row: DbRow): SubscriptionInfo {
  return {
    originalTransactionId: row.original_transaction_id,
    userId: row.user_id,
    productId: row.product_id,
    platform: row.platform as SubscriptionInfo['platform'],
    status: row.status as SubscriptionInfo['status'],
    expiresAt: row.expires_at.toISOString(),
    purchasedAt: row.purchased_at.toISOString(),
    willRenew: row.will_renew,
  };
}

interface PurchaseDbRow {
  transaction_id: string;
  user_id: string;
  product_id: string;
  platform: string;
  type: string;
  quantity: number;
  purchased_at: Date;
}

function rowToPurchaseInfo(row: PurchaseDbRow): PurchaseInfo {
  return {
    transactionId: row.transaction_id,
    userId: row.user_id,
    productId: row.product_id,
    platform: row.platform as PurchaseInfo['platform'],
    type: row.type as PurchaseInfo['type'],
    quantity: row.quantity,
    purchasedAt: row.purchased_at.toISOString(),
  };
}
