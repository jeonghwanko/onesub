/**
 * PostgresSubscriptionStore / PostgresPurchaseStore against a real database.
 *
 * Until now nothing executed this SQL. `schema.test.ts` compares the embedded DDL
 * strings to `sql/schema.sql` as text, which catches the two drifting apart but
 * says nothing about whether either one works, and every other suite runs on the
 * in-memory store. So the store that production actually uses was the least
 * verified code in the package — and two things shipped on the strength of
 * reading it: `getPurchasesForProduct`, and the claim in ARCHITECTURE.md that the
 * partial unique index is "the atomic guarantee" behind non-consumable dedup.
 *
 * Skipped unless `DATABASE_URL` is set, so a local `npm test` without a database
 * still passes. CI provides one through a service container.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PurchaseInfo, SubscriptionInfo } from '@onesub/shared';
import { PostgresSubscriptionStore, PostgresPurchaseStore } from '../stores/postgres.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describePg = DATABASE_URL ? describe : describe.skip;

function sub(overrides?: Partial<SubscriptionInfo>): SubscriptionInfo {
  return {
    userId: 'alice',
    productId: 'pro_monthly',
    platform: 'apple',
    status: 'active',
    expiresAt: '2099-01-01T00:00:00.000Z',
    purchasedAt: '2026-04-01T00:00:00.000Z',
    originalTransactionId: 'sub-1',
    willRenew: true,
    ...overrides,
  };
}

function purchase(overrides?: Partial<PurchaseInfo>): PurchaseInfo {
  return {
    userId: 'alice',
    productId: 'lifetime_pass',
    platform: 'apple',
    type: 'non_consumable',
    transactionId: 'pur-1',
    quantity: 1,
    purchasedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

describePg('Postgres stores', () => {
  let store: PostgresSubscriptionStore;
  let purchaseStore: PostgresPurchaseStore;
  // Raw client for truncation and for applying the shipped .sql by hand.
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const pg = await import('pg');
    const Pool = pg.default?.Pool ?? (pg as unknown as { Pool: typeof import('pg').Pool }).Pool;
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

    store = new PostgresSubscriptionStore(DATABASE_URL!);
    purchaseStore = new PostgresPurchaseStore(DATABASE_URL!);
    await store.initSchema();
    await purchaseStore.initSchema();
  });

  afterAll(async () => {
    await store.close();
    await purchaseStore.close();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE onesub_subscriptions, onesub_purchases');
  });

  // ── schema ───────────────────────────────────────────────────────────────

  describe('schema', () => {
    it('initSchema is safe to run repeatedly', async () => {
      // Hosts are told to call it at every startup, so it has to be idempotent
      // against an already-migrated database, not just an empty one.
      await store.initSchema();
      await store.initSchema();
      await purchaseStore.initSchema();
      await purchaseStore.initSchema();

      await store.save(sub());
      expect(await store.getByTransactionId('sub-1')).not.toBeNull();
    });

    it('the shipped sql/schema.sql produces a schema the stores can use', async () => {
      // schema.test.ts proves this file matches the embedded DDL as text. That
      // leaves open the possibility that both are wrong; applying it and then
      // driving the stores through it does not.
      const sqlPath = fileURLToPath(new URL('../../sql/schema.sql', import.meta.url));
      const schemaSql = readFileSync(sqlPath, 'utf-8');

      await pool.query('DROP TABLE IF EXISTS onesub_subscriptions, onesub_purchases');
      await pool.query(schemaSql);

      await store.save(sub());
      await purchaseStore.savePurchase(purchase());
      expect(await store.getByUserId('alice')).not.toBeNull();
      expect(await purchaseStore.hasPurchased('alice', 'lifetime_pass')).toBe(true);
    });
  });

  // ── the query shipped unverified in P4 ───────────────────────────────────

  describe('PurchaseStore.getPurchasesForProduct', () => {
    it('returns only the requested user + product', async () => {
      await purchaseStore.savePurchase(purchase({ transactionId: 'c1', productId: 'coins', type: 'consumable' }));
      await purchaseStore.savePurchase(purchase({ transactionId: 'c2', productId: 'coins', type: 'consumable' }));
      await purchaseStore.savePurchase(purchase({ transactionId: 'l1', productId: 'lifetime_pass' }));
      await purchaseStore.savePurchase(
        purchase({ transactionId: 'c3', productId: 'coins', type: 'consumable', userId: 'bob' }),
      );

      const rows = await purchaseStore.getPurchasesForProduct('alice', 'coins');
      expect(rows).toHaveLength(2);
      expect(rows.every((p) => p.userId === 'alice' && p.productId === 'coins')).toBe(true);
      expect(rows.map((p) => p.transactionId).sort()).toEqual(['c1', 'c2']);
    });

    it('orders most-recent-first, matching the interface contract', async () => {
      await purchaseStore.savePurchase(
        purchase({ transactionId: 'mid', productId: 'coins', type: 'consumable', purchasedAt: '2026-04-10T00:00:00.000Z' }),
      );
      await purchaseStore.savePurchase(
        purchase({ transactionId: 'newest', productId: 'coins', type: 'consumable', purchasedAt: '2026-08-01T00:00:00.000Z' }),
      );
      await purchaseStore.savePurchase(
        purchase({ transactionId: 'oldest', productId: 'coins', type: 'consumable', purchasedAt: '2026-01-01T00:00:00.000Z' }),
      );

      const rows = await purchaseStore.getPurchasesForProduct('alice', 'coins');
      expect(rows.map((p) => p.transactionId)).toEqual(['newest', 'mid', 'oldest']);
    });

    it('returns an empty array for an unknown user or product', async () => {
      await purchaseStore.savePurchase(purchase());
      expect(await purchaseStore.getPurchasesForProduct('alice', 'nope')).toEqual([]);
      expect(await purchaseStore.getPurchasesForProduct('nobody', 'lifetime_pass')).toEqual([]);
    });

    it('round-trips every field, not just the ones it filters on', async () => {
      await purchaseStore.savePurchase(
        purchase({ transactionId: 'g1', platform: 'google', type: 'consumable', productId: 'coins', quantity: 3 }),
      );
      const [row] = await purchaseStore.getPurchasesForProduct('alice', 'coins');
      expect(row).toEqual({
        transactionId: 'g1',
        userId: 'alice',
        productId: 'coins',
        platform: 'google',
        type: 'consumable',
        quantity: 3,
        purchasedAt: '2026-04-01T00:00:00.000Z',
      });
    });
  });

  // ── purchase ownership + the DB-level guarantee ──────────────────────────

  describe('PurchaseStore.savePurchase', () => {
    it('is idempotent for the same user and transactionId', async () => {
      await purchaseStore.savePurchase(purchase());
      await purchaseStore.savePurchase(purchase());
      expect(await purchaseStore.getPurchasesByUserId('alice')).toHaveLength(1);
    });

    it('refuses a transactionId already owned by someone else', async () => {
      await purchaseStore.savePurchase(purchase());
      await expect(
        purchaseStore.savePurchase(purchase({ userId: 'mallory' })),
      ).rejects.toThrow(/TRANSACTION_BELONGS_TO_OTHER_USER/);
      // The loser must not have acquired a row.
      expect(await purchaseStore.getPurchasesByUserId('mallory')).toEqual([]);
    });

    it('lets a user hold many consumable rows for one product', async () => {
      await purchaseStore.savePurchase(purchase({ transactionId: 'c1', productId: 'coins', type: 'consumable' }));
      await purchaseStore.savePurchase(purchase({ transactionId: 'c2', productId: 'coins', type: 'consumable' }));
      expect(await purchaseStore.getPurchasesForProduct('alice', 'coins')).toHaveLength(2);
    });

    it('the partial unique index blocks a second non-consumable row for the same user + product', async () => {
      // ARCHITECTURE.md calls this "the atomic guarantee" behind non-consumable
      // dedup, with the application-level check as a fast path. Nothing had
      // exercised it. Note the rejection is the raw constraint violation, not a
      // mapped ONESUB_ERROR_CODE — the route checks ownership first, so this
      // fires only on a concurrent double-insert or a direct admin grant.
      await purchaseStore.savePurchase(purchase({ transactionId: 'n1' }));
      await expect(purchaseStore.savePurchase(purchase({ transactionId: 'n2' }))).rejects.toThrow();
      expect(await purchaseStore.getPurchasesForProduct('alice', 'lifetime_pass')).toHaveLength(1);
    });
  });

  describe('PurchaseStore mutations', () => {
    it('deletePurchaseByTransactionId removes exactly one row', async () => {
      await purchaseStore.savePurchase(purchase({ transactionId: 'c1', productId: 'coins', type: 'consumable' }));
      await purchaseStore.savePurchase(purchase({ transactionId: 'c2', productId: 'coins', type: 'consumable' }));

      expect(await purchaseStore.deletePurchaseByTransactionId('c1')).toBe(true);
      expect(await purchaseStore.deletePurchaseByTransactionId('c1')).toBe(false);
      // The sibling consumable survives — the reason this method exists.
      expect(await purchaseStore.getPurchasesForProduct('alice', 'coins')).toHaveLength(1);
    });

    it('deletePurchases removes every row for the user + product', async () => {
      await purchaseStore.savePurchase(purchase({ transactionId: 'c1', productId: 'coins', type: 'consumable' }));
      await purchaseStore.savePurchase(purchase({ transactionId: 'c2', productId: 'coins', type: 'consumable' }));
      await purchaseStore.savePurchase(purchase({ transactionId: 'l1', productId: 'lifetime_pass' }));

      expect(await purchaseStore.deletePurchases('alice', 'coins')).toBe(2);
      expect(await purchaseStore.getPurchasesForProduct('alice', 'coins')).toEqual([]);
      expect(await purchaseStore.getPurchasesForProduct('alice', 'lifetime_pass')).toHaveLength(1);
    });

    it('reassignPurchase moves ownership and reports whether it found the row', async () => {
      await purchaseStore.savePurchase(purchase());
      expect(await purchaseStore.reassignPurchase('pur-1', 'bob')).toBe(true);
      expect(await purchaseStore.hasPurchased('alice', 'lifetime_pass')).toBe(false);
      expect(await purchaseStore.hasPurchased('bob', 'lifetime_pass')).toBe(true);
      expect(await purchaseStore.reassignPurchase('missing', 'bob')).toBe(false);
    });

    it('hasPurchased answers per user and product', async () => {
      await purchaseStore.savePurchase(purchase());
      expect(await purchaseStore.hasPurchased('alice', 'lifetime_pass')).toBe(true);
      expect(await purchaseStore.hasPurchased('alice', 'other')).toBe(false);
      expect(await purchaseStore.hasPurchased('bob', 'lifetime_pass')).toBe(false);
    });
  });

  // ── subscriptions ────────────────────────────────────────────────────────

  describe('SubscriptionStore', () => {
    it('save upserts on originalTransactionId rather than inserting again', async () => {
      await store.save(sub({ status: 'active' }));
      await store.save(sub({ status: 'canceled', willRenew: false }));

      const all = await store.getAllByUserId('alice');
      expect(all).toHaveLength(1);
      expect(all[0]?.status).toBe('canceled');
      expect(all[0]?.willRenew).toBe(false);
    });

    it('round-trips dates as ISO strings and optional columns as undefined', async () => {
      await store.save(sub());
      const fetched = await store.getByTransactionId('sub-1');
      expect(fetched?.expiresAt).toBe('2099-01-01T00:00:00.000Z');
      expect(fetched?.purchasedAt).toBe('2026-04-01T00:00:00.000Z');
      expect(fetched?.linkedPurchaseToken).toBeUndefined();
      expect(fetched?.autoResumeTime).toBeUndefined();
    });

    it('persists the optional columns when they are set', async () => {
      await store.save(
        sub({ linkedPurchaseToken: 'prev-token', autoResumeTime: '2026-09-01T00:00:00.000Z', status: 'paused' }),
      );
      const fetched = await store.getByTransactionId('sub-1');
      expect(fetched?.linkedPurchaseToken).toBe('prev-token');
      expect(fetched?.autoResumeTime).toBe('2026-09-01T00:00:00.000Z');
    });

    it('getByUserId returns the most recently updated record', async () => {
      await store.save(sub({ originalTransactionId: 'old', productId: 'pro_monthly' }));
      await store.save(sub({ originalTransactionId: 'new', productId: 'pro_yearly' }));

      // updated_at is NOW() on write, so the second save is the most recent.
      expect((await store.getByUserId('alice'))?.originalTransactionId).toBe('new');
    });

    it('getAllByUserId returns every record for the user and nobody else’s', async () => {
      await store.save(sub({ originalTransactionId: 't1', productId: 'pro_monthly' }));
      await store.save(sub({ originalTransactionId: 't2', productId: 'pro_yearly' }));
      await store.save(sub({ originalTransactionId: 't3', userId: 'bob' }));

      const all = await store.getAllByUserId('alice');
      expect(all).toHaveLength(2);
      expect(all.every((s) => s.userId === 'alice')).toBe(true);
    });

    it('rebinds a transaction to a new userId on re-validation', async () => {
      await store.save(sub({ userId: 'alice' }));
      await store.save(sub({ userId: 'bob' }));

      expect(await store.getAllByUserId('alice')).toEqual([]);
      expect(await store.getAllByUserId('bob')).toHaveLength(1);
    });
  });

  describe('SubscriptionStore.listFiltered', () => {
    beforeEach(async () => {
      await store.save(sub({ originalTransactionId: 'a1', status: 'active', productId: 'pro_monthly', platform: 'apple' }));
      await store.save(sub({ originalTransactionId: 'a2', status: 'expired', productId: 'pro_monthly', platform: 'apple' }));
      await store.save(sub({ originalTransactionId: 'g1', status: 'active', productId: 'pro_yearly', platform: 'google', userId: 'bob' }));
    });

    it('returns everything with no filters', async () => {
      const result = await store.listFiltered({});
      expect(result.total).toBe(3);
      expect(result.items).toHaveLength(3);
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
    });

    it('combines filters as AND', async () => {
      expect((await store.listFiltered({ status: 'active' })).total).toBe(2);
      expect((await store.listFiltered({ platform: 'apple' })).total).toBe(2);
      expect((await store.listFiltered({ status: 'active', platform: 'apple' })).total).toBe(1);
      expect((await store.listFiltered({ userId: 'bob', status: 'active' })).total).toBe(1);
      expect((await store.listFiltered({ userId: 'bob', status: 'expired' })).total).toBe(0);
    });

    it('filters by productId', async () => {
      expect((await store.listFiltered({ productId: 'pro_yearly' })).total).toBe(1);
    });

    it('reports the unpaged total alongside a limited page', async () => {
      const page = await store.listFiltered({ limit: 2 });
      expect(page.items).toHaveLength(2);
      expect(page.total).toBe(3);
    });

    it('pages without repeating or dropping a row', async () => {
      const first = await store.listFiltered({ limit: 2, offset: 0 });
      const second = await store.listFiltered({ limit: 2, offset: 2 });
      expect(second.items).toHaveLength(1);

      const ids = [...first.items, ...second.items].map((s) => s.originalTransactionId);
      expect(new Set(ids).size).toBe(3);
    });

    it('returns an empty page past the end, still with the true total', async () => {
      const result = await store.listFiltered({ limit: 2, offset: 99 });
      expect(result.items).toEqual([]);
      expect(result.total).toBe(3);
    });
  });

  describe('listAll', () => {
    it('returns every row from both stores', async () => {
      await store.save(sub({ originalTransactionId: 's1' }));
      await store.save(sub({ originalTransactionId: 's2', userId: 'bob' }));
      await purchaseStore.savePurchase(purchase({ transactionId: 'p1' }));
      await purchaseStore.savePurchase(purchase({ transactionId: 'p2', userId: 'bob' }));

      expect(await store.listAll()).toHaveLength(2);
      expect(await purchaseStore.listAll()).toHaveLength(2);
    });

    it('returns an empty array on an empty table', async () => {
      expect(await store.listAll()).toEqual([]);
      expect(await purchaseStore.listAll()).toEqual([]);
    });
  });
});
