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
import {
  aggregateActiveSubscriptions,
  aggregateNonConsumablePurchases,
  aggregateRange,
  isEndedSubscription,
  isNonConsumable,
} from '../metrics-aggregate.js';

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

  // ── metrics aggregation: SQL must equal the in-memory reducer ─────────────
  //
  // These are the point of the whole aggregation change. `metrics-aggregate.ts`
  // is the definition of what a metrics response means; the SQL is an
  // optimisation that has to produce byte-identical output. Rather than restate
  // expected numbers, each test runs BOTH over the same rows and compares — so a
  // timezone slip, an exclusive bound, or a missed zero-fill fails here instead
  // of quietly changing what operators see.

  describe('aggregateActive equals the in-memory reduction', () => {
    const NOW = new Date('2026-06-15T12:00:00.000Z');

    async function bothWays() {
      const sql = await store.aggregateActive!(NOW);
      const memory = aggregateActiveSubscriptions(await store.listAll(), NOW.getTime());
      return { sql, memory };
    }

    it('agrees on an empty table', async () => {
      const { sql, memory } = await bothWays();
      expect(sql).toEqual(memory);
      expect(sql.active).toBe(0);
    });

    it('agrees across statuses, products and platforms', async () => {
      await store.save(sub({ originalTransactionId: 'a', status: 'active', expiresAt: '2026-07-01T00:00:00.000Z' }));
      await store.save(sub({ originalTransactionId: 'b', status: 'grace_period', expiresAt: '2026-07-01T00:00:00.000Z', platform: 'google' }));
      await store.save(sub({ originalTransactionId: 'c', status: 'grace_period', expiresAt: '2026-07-01T00:00:00.000Z', productId: 'pro_yearly' }));
      // Excluded: right status, already expired.
      await store.save(sub({ originalTransactionId: 'd', status: 'active', expiresAt: '2026-01-01T00:00:00.000Z' }));
      // Excluded: on_hold / paused do not grant entitlement.
      await store.save(sub({ originalTransactionId: 'e', status: 'on_hold', expiresAt: '2026-07-01T00:00:00.000Z' }));
      await store.save(sub({ originalTransactionId: 'f', status: 'paused', expiresAt: '2026-07-01T00:00:00.000Z' }));

      const { sql, memory } = await bothWays();
      expect(sql).toEqual(memory);
      expect(sql.active).toBe(3);
      expect(sql.gracePeriod).toBe(2);
    });

    it('agrees on the expiry boundary, which is strictly greater-than', async () => {
      // expires_at exactly == now must NOT count, matching isActiveSubscription.
      await store.save(sub({ originalTransactionId: 'exact', status: 'active', expiresAt: NOW.toISOString() }));
      const { sql, memory } = await bothWays();
      expect(sql).toEqual(memory);
      expect(sql.active).toBe(0);
    });
  });

  describe('aggregateNonConsumable equals the in-memory reduction', () => {
    it('counts non-consumables only, and agrees', async () => {
      await purchaseStore.savePurchase(purchase({ transactionId: 'n1', productId: 'lifetime_pass' }));
      await purchaseStore.savePurchase(purchase({ transactionId: 'n2', productId: 'remove_ads', platform: 'google' }));
      await purchaseStore.savePurchase(purchase({ transactionId: 'c1', productId: 'coins', type: 'consumable' }));

      const sql = await purchaseStore.aggregateNonConsumable!();
      const memory = aggregateNonConsumablePurchases(await purchaseStore.listAll());
      expect(sql).toEqual(memory);
      expect(sql.total).toBe(2);
      expect(sql.byProduct).toEqual({ lifetime_pass: 1, remove_ads: 1 });
    });
  });

  describe('aggregateStarted / aggregateExpired equal the in-memory reduction', () => {
    const from = new Date('2026-04-01T00:00:00.000Z');
    const to = new Date('2026-04-30T23:59:59.999Z');

    async function seedSpread() {
      await store.save(sub({ originalTransactionId: 'before', purchasedAt: '2026-03-31T23:59:59.999Z' }));
      await store.save(sub({ originalTransactionId: 'lower', purchasedAt: '2026-04-01T00:00:00.000Z' }));
      await store.save(sub({ originalTransactionId: 'mid', purchasedAt: '2026-04-15T09:30:00.000Z', productId: 'pro_yearly' }));
      await store.save(sub({ originalTransactionId: 'upper', purchasedAt: '2026-04-30T23:59:59.999Z', platform: 'google' }));
      await store.save(sub({ originalTransactionId: 'after', purchasedAt: '2026-05-01T00:00:00.000Z' }));
    }

    it('agrees on inclusive window bounds without bucketing', async () => {
      await seedSpread();
      const sql = await store.aggregateStarted!({ from, to, groupBy: 'none' });
      const memory = aggregateRange(await store.listAll(), {
        fromMs: from.getTime(),
        toMs: to.getTime(),
        groupBy: 'none',
        anchor: (s) => s.purchasedAt,
      });
      expect(sql).toEqual(memory);
      expect(sql.total).toBe(3);
      expect(sql.buckets).toBeUndefined();
    });

    it('agrees on zero-filled daily buckets', async () => {
      await seedSpread();
      const sql = await store.aggregateStarted!({ from, to, groupBy: 'day' });
      const memory = aggregateRange(await store.listAll(), {
        fromMs: from.getTime(),
        toMs: to.getTime(),
        groupBy: 'day',
        anchor: (s) => s.purchasedAt,
      });
      expect(sql).toEqual(memory);
      expect(sql.buckets).toHaveLength(30);
      expect(sql.buckets!.reduce((n, b) => n + b.count, 0)).toBe(sql.total);
    });

    it('assigns a UTC day even when the offset would move it', async () => {
      // 23:30 at UTC−05:00 is already the next UTC day. `date_trunc` truncates in
      // the SESSION timezone, so without the explicit UTC cast the SQL would
      // bucket this differently from `utcDateKey`.
      await store.save(sub({ originalTransactionId: 'edge', purchasedAt: '2026-04-10T23:30:00-05:00' }));
      const sql = await store.aggregateStarted!({ from, to, groupBy: 'day' });
      const memory = aggregateRange(await store.listAll(), {
        fromMs: from.getTime(),
        toMs: to.getTime(),
        groupBy: 'day',
        anchor: (s) => s.purchasedAt,
      });
      expect(sql).toEqual(memory);
      expect(sql.buckets!.find((b) => b.date === '2026-04-11')?.count).toBe(1);
      expect(sql.buckets!.find((b) => b.date === '2026-04-10')?.count).toBe(0);
    });

    it('agrees on expired, which filters by status as well as window', async () => {
      await store.save(sub({ originalTransactionId: 'exp', status: 'expired', expiresAt: '2026-04-10T00:00:00.000Z' }));
      await store.save(sub({ originalTransactionId: 'can', status: 'canceled', expiresAt: '2026-04-20T00:00:00.000Z', productId: 'pro_yearly' }));
      // Still active, expiry inside the window — must not count.
      await store.save(sub({ originalTransactionId: 'act', status: 'active', expiresAt: '2026-04-25T00:00:00.000Z' }));
      // Ended, expiry outside the window.
      await store.save(sub({ originalTransactionId: 'old', status: 'expired', expiresAt: '2026-01-01T00:00:00.000Z' }));

      const sql = await store.aggregateExpired!({ from, to, groupBy: 'day' });
      const memory = aggregateRange(await store.listAll(), {
        fromMs: from.getTime(),
        toMs: to.getTime(),
        groupBy: 'day',
        anchor: (s) => s.expiresAt,
        include: isEndedSubscription,
      });
      expect(sql).toEqual(memory);
      expect(sql.total).toBe(2);
    });

    it('agrees on purchases started, which filters consumables out', async () => {
      await purchaseStore.savePurchase(purchase({ transactionId: 'n1', purchasedAt: '2026-04-05T00:00:00.000Z' }));
      await purchaseStore.savePurchase(purchase({ transactionId: 'c1', productId: 'coins', type: 'consumable', purchasedAt: '2026-04-06T00:00:00.000Z' }));
      await purchaseStore.savePurchase(purchase({ transactionId: 'n2', productId: 'remove_ads', purchasedAt: '2026-05-10T00:00:00.000Z' }));

      const sql = await purchaseStore.aggregateStarted!({ from, to, groupBy: 'day' });
      const memory = aggregateRange(await purchaseStore.listAll(), {
        fromMs: from.getTime(),
        toMs: to.getTime(),
        groupBy: 'day',
        anchor: (p) => p.purchasedAt,
        include: isNonConsumable,
      });
      expect(sql).toEqual(memory);
      expect(sql.total).toBe(1);
    });

    it('agrees even when the database session is not in UTC', async () => {
      // This is the test that has to exist rather than be assumed. `date_trunc`
      // truncates in the SESSION timezone, so the aggregate is only correct
      // because of an explicit `AT TIME ZONE 'UTC'`. A CI container running UTC
      // cannot tell a correct implementation from one missing that cast — every
      // other test here would pass either way. So this one forces a hostile
      // session timezone and re-checks the equivalence.
      const url = new URL(DATABASE_URL!);
      url.searchParams.set('options', '-c timezone=America/New_York');
      const skewed = new PostgresSubscriptionStore(url.toString());
      try {
        // 02:00 UTC is still the previous day in New York, so a session-local
        // truncation would file this under 2026-04-09.
        await store.save(sub({ originalTransactionId: 'tz', purchasedAt: '2026-04-10T02:00:00.000Z' }));

        const sql = await skewed.aggregateStarted!({ from, to, groupBy: 'day' });
        const memory = aggregateRange(await store.listAll(), {
          fromMs: from.getTime(),
          toMs: to.getTime(),
          groupBy: 'day',
          anchor: (s) => s.purchasedAt,
        });

        expect(sql).toEqual(memory);
        expect(sql.buckets!.find((b) => b.date === '2026-04-10')?.count).toBe(1);
        expect(sql.buckets!.find((b) => b.date === '2026-04-09')?.count).toBe(0);
      } finally {
        await skewed.close();
      }
    });

    it('agrees when nothing falls in the window', async () => {
      await store.save(sub({ originalTransactionId: 'far', purchasedAt: '2020-01-01T00:00:00.000Z' }));
      const sql = await store.aggregateStarted!({ from, to, groupBy: 'day' });
      const memory = aggregateRange(await store.listAll(), {
        fromMs: from.getTime(),
        toMs: to.getTime(),
        groupBy: 'day',
        anchor: (s) => s.purchasedAt,
      });
      expect(sql).toEqual(memory);
      expect(sql.total).toBe(0);
      expect(sql.byProduct).toEqual({});
      // Still a full zero-filled series, so a chart renders flat rather than empty.
      expect(sql.buckets).toHaveLength(30);
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
