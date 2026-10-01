/**
 * The behavioural contract every built-in SubscriptionStore / PurchaseStore
 * must meet, as a function each store's suite calls with its own factory.
 *
 * AGENTS.md asks that a change to one store moves all three. Per-store suites
 * cannot hold that line on their own: each was written against its own
 * implementation, so a behaviour only one store has — rebind cleanup, ordering,
 * an ownership or uniqueness rule — passes in that store's file and is never
 * asserted for the others. That is how earlier parity bugs shipped.
 *
 * Callers: `store-contract.test.ts` (in-memory, Redis on ioredis-mock) and
 * `postgres-store.test.ts` (Postgres, when DATABASE_URL is set). Postgres runs
 * from its own file because the two files would otherwise TRUNCATE the same
 * tables from parallel workers. Store-specific details — SQL aggregates, Redis
 * key layout, schema migration — stay in the per-store files.
 *
 * Not a `.test.ts`, so the Vitest include glob does not run it on its own.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PurchaseInfo, SubscriptionInfo } from '@onesub/shared';
import { ONESUB_ERROR_CODE, SUBSCRIPTION_STATUS } from '@onesub/shared';
import type { PurchaseStore, SubscriptionStore } from '../store.js';

export interface StoreFactory {
  name: string;
  setup(): Promise<void>;
  /** Empty stores for one test. */
  reset(): Promise<{ subs: SubscriptionStore; purchases: PurchaseStore }>;
  teardown(): Promise<void>;
}

/**
 * Stores that order by write time get the order from a clock: Redis scores by
 * `Date.now()` (ms), Postgres by `NOW()`. Two writes inside one millisecond tie,
 * so ordering cases leave a gap between writes, as a real request stream would.
 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function sub(overrides: Partial<SubscriptionInfo> = {}): SubscriptionInfo {
  return {
    originalTransactionId: 'otx-1',
    userId: 'alice',
    productId: 'pro_monthly',
    platform: 'apple',
    status: SUBSCRIPTION_STATUS.ACTIVE,
    expiresAt: '2030-01-01T00:00:00.000Z',
    purchasedAt: '2025-01-01T00:00:00.000Z',
    willRenew: true,
    ...overrides,
  };
}

function purchase(overrides: Partial<PurchaseInfo> = {}): PurchaseInfo {
  return {
    transactionId: 'tx-1',
    userId: 'alice',
    productId: 'coins',
    platform: 'google',
    type: 'consumable',
    quantity: 1,
    purchasedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function ids<T extends { originalTransactionId?: string; transactionId?: string }>(rows: T[]): string[] {
  return rows.map((r) => r.originalTransactionId ?? r.transactionId ?? '?');
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err, `expected a rejection with code ${code}`).not.toBeNull();
  expect((err as { code?: unknown }).code).toBe(code);
}

export function describeStoreContract(factory: StoreFactory): void {
  describeSubscriptionContract(factory);
  describePurchaseContract(factory);
}

function describeSubscriptionContract(factory: StoreFactory): void {
  describe(`${factory.name} — SubscriptionStore contract`, () => {
    let subs: SubscriptionStore;

    beforeAll(() => factory.setup());
    afterAll(() => factory.teardown());
    beforeEach(async () => {
      ({ subs } = await factory.reset());
    });

    it('round-trips every field, including the optional ones', async () => {
      const full = sub({
        linkedPurchaseToken: 'prev-token',
        autoResumeTime: '2030-02-01T00:00:00.000Z',
      stateAsOf: '2029-12-31T23:59:59.123Z',
        platform: 'google',
        status: SUBSCRIPTION_STATUS.PAUSED,
        willRenew: false,
      });
      await subs.save(full);
      expect(await subs.getByTransactionId('otx-1')).toEqual(full);
    });

    it('returns null / [] for unknown ids', async () => {
      expect(await subs.getByTransactionId('nope')).toBeNull();
      expect(await subs.getByUserId('nobody')).toBeNull();
      expect(await subs.getAllByUserId('nobody')).toEqual([]);
    });

    it('save is an upsert keyed by originalTransactionId', async () => {
      await subs.save(sub());
      await subs.save(sub({ status: SUBSCRIPTION_STATUS.EXPIRED, willRenew: false }));
      expect((await subs.getByTransactionId('otx-1'))?.status).toBe(SUBSCRIPTION_STATUS.EXPIRED);
      expect(await subs.getAllByUserId('alice')).toHaveLength(1);
      expect(await subs.listAll()).toHaveLength(1);
    });

    it('does not overwrite a record with an older snapshot', async () => {
      await subs.save(sub({ status: SUBSCRIPTION_STATUS.ACTIVE, stateAsOf: '2026-01-02T00:00:00.000Z' }));
      await subs.save(sub({ status: SUBSCRIPTION_STATUS.EXPIRED, stateAsOf: '2026-01-01T00:00:00.000Z' }));
      const rec = await subs.getByTransactionId('otx-1');
      expect(rec?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
      expect(rec?.stateAsOf).toBe('2026-01-02T00:00:00.000Z');

      // Equal or newer applies; so does a write that carries no snapshot.
      await subs.save(sub({ status: SUBSCRIPTION_STATUS.GRACE_PERIOD, stateAsOf: '2026-01-02T00:00:00.000Z' }));
      expect((await subs.getByTransactionId('otx-1'))?.status).toBe(SUBSCRIPTION_STATUS.GRACE_PERIOD);
      await subs.save(sub({ status: SUBSCRIPTION_STATUS.ON_HOLD }));
      expect((await subs.getByTransactionId('otx-1'))?.status).toBe(SUBSCRIPTION_STATUS.ON_HOLD);
    });

    it('keeps the newer snapshot when an older one is saved concurrently', async () => {
      for (let i = 0; i < 5; i++) {
        const id = `race-${i}`;
        await subs.save(sub({ originalTransactionId: id, stateAsOf: '2026-01-01T00:00:00.000Z' }));
        await Promise.all([
          subs.save(sub({ originalTransactionId: id, status: SUBSCRIPTION_STATUS.EXPIRED, stateAsOf: '2026-01-01T00:01:00.000Z' })),
          subs.save(sub({ originalTransactionId: id, status: SUBSCRIPTION_STATUS.ACTIVE, stateAsOf: '2026-01-01T00:02:00.000Z' })),
          subs.save(sub({ originalTransactionId: id, status: SUBSCRIPTION_STATUS.ON_HOLD, stateAsOf: '2026-01-01T00:00:30.000Z' })),
        ]);
        const rec = await subs.getByTransactionId(id);
        expect(rec?.stateAsOf).toBe('2026-01-01T00:02:00.000Z');
        expect(rec?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
      }
    });

    it('rebinding to another userId removes the record from the previous user', async () => {
      await subs.save(sub({ userId: 'alice' }));
      await subs.save(sub({ userId: 'bob' }));
      expect(await subs.getByUserId('alice')).toBeNull();
      expect(await subs.getAllByUserId('alice')).toEqual([]);
      expect((await subs.getByUserId('bob'))?.originalTransactionId).toBe('otx-1');
    });

    it('orders a user’s records most-recently-written first', async () => {
      await subs.save(sub({ originalTransactionId: 'a' }));
      await tick();
      await subs.save(sub({ originalTransactionId: 'b' }));
      await tick();
      await subs.save(sub({ originalTransactionId: 'c' }));
      await tick();
      // Re-writing `a` makes it the most recent.
      await subs.save(sub({ originalTransactionId: 'a', status: SUBSCRIPTION_STATUS.EXPIRED }));

      expect(ids(await subs.getAllByUserId('alice'))).toEqual(['a', 'c', 'b']);
      expect((await subs.getByUserId('alice'))?.originalTransactionId).toBe('a');
    });

    it('listFiltered orders across users most-recently-written first', async () => {
      await subs.save(sub({ originalTransactionId: 'a1', userId: 'alice' }));
      await tick();
      await subs.save(sub({ originalTransactionId: 'b1', userId: 'bob' }));
      await tick();
      await subs.save(sub({ originalTransactionId: 'a2', userId: 'alice' }));

      const result = await subs.listFiltered({});
      expect(ids(result.items)).toEqual(['a2', 'b1', 'a1']);
      expect(result.total).toBe(3);
    });

    it('listFiltered applies every filter as AND, and paginates with a stable total', async () => {
      await subs.save(sub({ originalTransactionId: 's1', userId: 'u1', platform: 'apple', productId: 'p1' }));
      await tick();
      await subs.save(sub({ originalTransactionId: 's2', userId: 'u1', platform: 'google', productId: 'p1' }));
      await tick();
      await subs.save(sub({ originalTransactionId: 's3', userId: 'u2', platform: 'google', productId: 'p2', status: SUBSCRIPTION_STATUS.EXPIRED }));
      await tick();
      await subs.save(sub({ originalTransactionId: 's4', userId: 'u2', platform: 'google', productId: 'p1' }));

      expect(ids((await subs.listFiltered({ platform: 'google', productId: 'p1' })).items)).toEqual(['s4', 's2']);
      expect(ids((await subs.listFiltered({ userId: 'u2', status: SUBSCRIPTION_STATUS.EXPIRED })).items)).toEqual(['s3']);

      const page = await subs.listFiltered({ platform: 'google', limit: 2, offset: 1 });
      expect(page.total).toBe(3);
      expect(page.limit).toBe(2);
      expect(page.offset).toBe(1);
      expect(ids(page.items)).toEqual(['s3', 's2']);
    });
  });
}

function describePurchaseContract(factory: StoreFactory): void {
  describe(`${factory.name} — PurchaseStore contract`, () => {
    let purchases: PurchaseStore;

    beforeAll(() => factory.setup());
    afterAll(() => factory.teardown());
    beforeEach(async () => {
      ({ purchases } = await factory.reset());
    });

    it('round-trips a purchase', async () => {
      const p = purchase({ quantity: 3, type: 'non_consumable', productId: 'lifetime' });
      await purchases.savePurchase(p);
      expect(await purchases.getPurchaseByTransactionId('tx-1')).toEqual(p);
      expect(await purchases.getPurchaseByTransactionId('nope')).toBeNull();
    });

    it('re-saving for the same user is idempotent', async () => {
      await purchases.savePurchase(purchase());
      await purchases.savePurchase(purchase());
      expect(await purchases.getPurchasesByUserId('alice')).toHaveLength(1);
      expect(await purchases.listAll()).toHaveLength(1);
    });

    it('refuses a transactionId owned by another user, with the ownership code', async () => {
      await purchases.savePurchase(purchase({ userId: 'alice' }));
      await expectCode(
        purchases.savePurchase(purchase({ userId: 'mallory' })),
        ONESUB_ERROR_CODE.TRANSACTION_BELONGS_TO_OTHER_USER,
      );
      expect(await purchases.getPurchasesByUserId('mallory')).toEqual([]);
    });

    it('refuses a second non-consumable row for the same user and product', async () => {
      await purchases.savePurchase(purchase({ transactionId: 'nc-1', type: 'non_consumable', productId: 'lifetime' }));
      await expectCode(
        purchases.savePurchase(purchase({ transactionId: 'nc-2', type: 'non_consumable', productId: 'lifetime' })),
        ONESUB_ERROR_CODE.NON_CONSUMABLE_ALREADY_OWNED,
      );
      expect(ids(await purchases.getPurchasesForProduct!('alice', 'lifetime'))).toEqual(['nc-1']);
      // Another user may own the same product; consumables may repeat.
      await purchases.savePurchase(purchase({ transactionId: 'nc-3', userId: 'bob', type: 'non_consumable', productId: 'lifetime' }));
      await purchases.savePurchase(purchase({ transactionId: 'c-1' }));
      await purchases.savePurchase(purchase({ transactionId: 'c-2' }));
      expect(await purchases.getPurchasesForProduct!('alice', 'coins')).toHaveLength(2);
    });

    it('lets exactly one of two concurrent non-consumable saves win', async () => {
      for (let i = 0; i < 5; i++) {
        const productId = `lifetime-${i}`;
        const results = await Promise.allSettled([
          purchases.savePurchase(purchase({ transactionId: `a-${i}`, type: 'non_consumable', productId })),
          purchases.savePurchase(purchase({ transactionId: `b-${i}`, type: 'non_consumable', productId })),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        expect((rejected.reason as { code?: string }).code).toBe(ONESUB_ERROR_CODE.NON_CONSUMABLE_ALREADY_OWNED);
        expect(await purchases.getPurchasesForProduct!('alice', productId)).toHaveLength(1);
        expect(await purchases.listAll()).toHaveLength(i + 1);
      }
    });

    it('a deleted non-consumable can be bought again', async () => {
      await purchases.savePurchase(purchase({ transactionId: 'nc-1', type: 'non_consumable', productId: 'lifetime' }));
      expect(await purchases.deletePurchaseByTransactionId('nc-1')).toBe(true);
      await purchases.savePurchase(purchase({ transactionId: 'nc-2', type: 'non_consumable', productId: 'lifetime' }));
      expect(await purchases.hasPurchased('alice', 'lifetime')).toBe(true);
    });

    it('orders a user’s purchases by purchasedAt, newest first, whatever the write order', async () => {
      await purchases.savePurchase(purchase({ transactionId: 'mid', purchasedAt: '2025-02-01T00:00:00.000Z' }));
      await purchases.savePurchase(purchase({ transactionId: 'old', purchasedAt: '2025-01-01T00:00:00.000Z' }));
      await purchases.savePurchase(purchase({ transactionId: 'new', purchasedAt: '2025-03-01T00:00:00.000Z', productId: 'gems' }));

      expect(ids(await purchases.getPurchasesByUserId('alice'))).toEqual(['new', 'mid', 'old']);
      expect(ids(await purchases.getPurchasesForProduct!('alice', 'coins'))).toEqual(['mid', 'old']);
    });

    it('hasPurchased reflects saves and deletes', async () => {
      expect(await purchases.hasPurchased('alice', 'coins')).toBe(false);
      await purchases.savePurchase(purchase());
      expect(await purchases.hasPurchased('alice', 'coins')).toBe(true);
      expect(await purchases.hasPurchased('alice', 'gems')).toBe(false);
    });

    it('reassignPurchase moves the row and keeps the new owner’s order', async () => {
      await purchases.savePurchase(purchase({ transactionId: 'bob-new', userId: 'bob', purchasedAt: '2025-03-01T00:00:00.000Z' }));
      await purchases.savePurchase(purchase({ transactionId: 'bob-old', userId: 'bob', purchasedAt: '2025-01-01T00:00:00.000Z' }));
      await purchases.savePurchase(purchase({ transactionId: 'moved', userId: 'alice', purchasedAt: '2025-02-01T00:00:00.000Z' }));

      expect(await purchases.reassignPurchase('moved', 'bob')).toBe(true);
      expect(await purchases.getPurchasesByUserId('alice')).toEqual([]);
      expect(await purchases.hasPurchased('alice', 'coins')).toBe(false);
      expect((await purchases.getPurchaseByTransactionId('moved'))?.userId).toBe('bob');
      expect(ids(await purchases.getPurchasesByUserId('bob'))).toEqual(['bob-new', 'moved', 'bob-old']);

      expect(await purchases.reassignPurchase('nope', 'bob')).toBe(false);
      expect(await purchases.reassignPurchase('moved', 'bob')).toBe(true);
    });

    it('reassigning a non-consumable onto a user who already owns it is refused, and nothing moves', async () => {
      await purchases.savePurchase(purchase({ transactionId: 'a-nc', userId: 'alice', type: 'non_consumable', productId: 'lifetime' }));
      await purchases.savePurchase(purchase({ transactionId: 'b-nc', userId: 'bob', type: 'non_consumable', productId: 'lifetime' }));

      await expectCode(purchases.reassignPurchase('a-nc', 'bob'), ONESUB_ERROR_CODE.NON_CONSUMABLE_ALREADY_OWNED);
      expect((await purchases.getPurchaseByTransactionId('a-nc'))?.userId).toBe('alice');
      expect(ids(await purchases.getPurchasesForProduct!('bob', 'lifetime'))).toEqual(['b-nc']);
    });

    it('deletePurchases removes one product for one user and reports the count', async () => {
      await purchases.savePurchase(purchase({ transactionId: 'c-1' }));
      await purchases.savePurchase(purchase({ transactionId: 'c-2' }));
      await purchases.savePurchase(purchase({ transactionId: 'g-1', productId: 'gems' }));
      await purchases.savePurchase(purchase({ transactionId: 'bob-c', userId: 'bob' }));

      expect(await purchases.deletePurchases('alice', 'coins')).toBe(2);
      expect(ids(await purchases.getPurchasesByUserId('alice'))).toEqual(['g-1']);
      expect(await purchases.getPurchaseByTransactionId('c-1')).toBeNull();
      expect(await purchases.hasPurchased('bob', 'coins')).toBe(true);
      expect(await purchases.deletePurchases('alice', 'coins')).toBe(0);
    });

    it('deletePurchaseByTransactionId removes exactly that row', async () => {
      await purchases.savePurchase(purchase({ transactionId: 'c-1' }));
      await purchases.savePurchase(purchase({ transactionId: 'c-2' }));

      expect(await purchases.deletePurchaseByTransactionId('c-1')).toBe(true);
      expect(ids(await purchases.getPurchasesByUserId('alice'))).toEqual(['c-2']);
      expect(await purchases.listAll()).toHaveLength(1);
      expect(await purchases.deletePurchaseByTransactionId('c-1')).toBe(false);
    });
  });
}
