/**
 * metrics-aggregate — the reduction behind every /onesub/metrics/* response.
 *
 * These semantics were previously only reachable through four HTTP handlers, so
 * the fiddly parts (inclusive window edges, UTC bucket assignment, which records
 * a distribution counts) had no direct coverage. They do now, and they are the
 * contract any future SQL-side aggregation has to reproduce.
 */

import { describe, it, expect } from 'vitest';
import type { PurchaseInfo, SubscriptionInfo } from '@onesub/shared';
import {
  aggregateActive,
  aggregateRange,
  emptyDailyBuckets,
  isActiveSubscription,
  isEndedSubscription,
  isNonConsumable,
  utcDateKey,
} from '../metrics-aggregate.js';

function sub(overrides?: Partial<SubscriptionInfo>): SubscriptionInfo {
  return {
    userId: 'u',
    productId: 'pro_monthly',
    platform: 'apple',
    status: 'active',
    expiresAt: '2099-01-01T00:00:00.000Z',
    purchasedAt: '2026-04-10T00:00:00.000Z',
    originalTransactionId: `orig_${Math.random()}`,
    willRenew: true,
    ...overrides,
  };
}

function purchase(overrides?: Partial<PurchaseInfo>): PurchaseInfo {
  return {
    userId: 'u',
    productId: 'lifetime_pass',
    platform: 'apple',
    type: 'non_consumable',
    transactionId: `tx_${Math.random()}`,
    purchasedAt: '2026-04-10T00:00:00.000Z',
    quantity: 1,
    ...overrides,
  };
}

const ms = (iso: string) => new Date(iso).getTime();
const APRIL = { fromMs: ms('2026-04-01T00:00:00Z'), toMs: ms('2026-04-30T23:59:59.999Z') };

describe('utcDateKey', () => {
  it('formats as UTC YYYY-MM-DD regardless of the local zone', () => {
    expect(utcDateKey(ms('2026-04-10T00:00:00Z'))).toBe('2026-04-10');
    expect(utcDateKey(ms('2026-04-10T23:59:59Z'))).toBe('2026-04-10');
    // 23:30 in UTC−05:00 is already the next UTC day.
    expect(utcDateKey(ms('2026-04-10T23:30:00-05:00'))).toBe('2026-04-11');
  });

  it('zero-pads single-digit months and days', () => {
    expect(utcDateKey(ms('2026-01-05T12:00:00Z'))).toBe('2026-01-05');
  });
});

describe('emptyDailyBuckets', () => {
  it('covers both boundary days inclusively', () => {
    const buckets = emptyDailyBuckets(ms('2026-04-01T10:00:00Z'), ms('2026-04-03T01:00:00Z'));
    expect(buckets.map((b) => b.date)).toEqual(['2026-04-01', '2026-04-02', '2026-04-03']);
    expect(buckets.every((b) => b.count === 0)).toBe(true);
  });

  it('returns a single bucket for a window inside one day', () => {
    const buckets = emptyDailyBuckets(ms('2026-04-01T01:00:00Z'), ms('2026-04-01T23:00:00Z'));
    expect(buckets).toEqual([{ date: '2026-04-01', count: 0 }]);
  });
});

describe('aggregateRange — window', () => {
  it('includes records on both bounds and excludes those outside', () => {
    const records = [
      sub({ purchasedAt: '2026-03-31T23:59:59.999Z' }), // just before
      sub({ purchasedAt: '2026-04-01T00:00:00.000Z' }), // exactly from
      sub({ purchasedAt: '2026-04-15T00:00:00.000Z' }), // inside
      sub({ purchasedAt: '2026-04-30T23:59:59.999Z' }), // exactly to
      sub({ purchasedAt: '2026-05-01T00:00:00.000Z' }), // just after
    ];
    const result = aggregateRange(records, {
      ...APRIL,
      groupBy: 'none',
      anchor: (s) => s.purchasedAt,
    });
    expect(result.total).toBe(3);
  });

  it('omits buckets unless groupBy is day', () => {
    const result = aggregateRange([sub()], { ...APRIL, groupBy: 'none', anchor: (s) => s.purchasedAt });
    expect(result.buckets).toBeUndefined();
  });

  it('skips records whose anchor is not a parseable timestamp', () => {
    const result = aggregateRange([sub({ purchasedAt: 'not-a-date' }), sub()], {
      ...APRIL,
      groupBy: 'none',
      anchor: (s) => s.purchasedAt,
    });
    expect(result.total).toBe(1);
  });
});

describe('aggregateRange — distributions', () => {
  it('tallies product and platform for included records only', () => {
    const records = [
      sub({ productId: 'pro_monthly', platform: 'apple' }),
      sub({ productId: 'pro_monthly', platform: 'google' }),
      sub({ productId: 'pro_yearly', platform: 'google' }),
      sub({ productId: 'excluded_by_window', purchasedAt: '2026-01-01T00:00:00Z' }),
    ];
    const result = aggregateRange(records, {
      ...APRIL,
      groupBy: 'none',
      anchor: (s) => s.purchasedAt,
    });

    expect(result.total).toBe(3);
    expect(result.byProduct).toEqual({ pro_monthly: 2, pro_yearly: 1 });
    expect(result.byPlatform).toEqual({ apple: 1, google: 2 });
  });

  it('applies the include predicate before anything else is counted', () => {
    const records = [
      sub({ status: 'expired', expiresAt: '2026-04-10T00:00:00Z', productId: 'gone' }),
      sub({ status: 'active', expiresAt: '2026-04-11T00:00:00Z', productId: 'still_here' }),
    ];
    const result = aggregateRange(records, {
      ...APRIL,
      groupBy: 'none',
      anchor: (s) => s.expiresAt,
      include: isEndedSubscription,
    });

    expect(result.total).toBe(1);
    expect(result.byProduct).toEqual({ gone: 1 });
    expect(result.byPlatform).toEqual({ apple: 1 });
  });
});

describe('aggregateRange — daily buckets', () => {
  it('zero-fills the whole window and counts into the right UTC day', () => {
    const records = [
      sub({ purchasedAt: '2026-04-01T00:00:00Z' }),
      sub({ purchasedAt: '2026-04-01T23:59:00Z' }),
      sub({ purchasedAt: '2026-04-03T12:00:00Z' }),
    ];
    const result = aggregateRange(records, {
      fromMs: ms('2026-04-01T00:00:00Z'),
      toMs: ms('2026-04-04T23:59:59Z'),
      groupBy: 'day',
      anchor: (s) => s.purchasedAt,
    });

    expect(result.buckets).toEqual([
      { date: '2026-04-01', count: 2 },
      { date: '2026-04-02', count: 0 },
      { date: '2026-04-03', count: 1 },
      { date: '2026-04-04', count: 0 },
    ]);
    // Bucket counts must reconcile with the total.
    expect(result.buckets!.reduce((n, b) => n + b.count, 0)).toBe(result.total);
  });

  it('keeps bucket sum equal to total when records are filtered out', () => {
    const records = [
      purchase({ type: 'non_consumable', purchasedAt: '2026-04-02T00:00:00Z' }),
      purchase({ type: 'consumable', purchasedAt: '2026-04-02T00:00:00Z' }),
    ];
    const result = aggregateRange(records, {
      fromMs: ms('2026-04-01T00:00:00Z'),
      toMs: ms('2026-04-03T00:00:00Z'),
      groupBy: 'day',
      anchor: (p) => p.purchasedAt,
      include: isNonConsumable,
    });

    expect(result.total).toBe(1);
    expect(result.buckets!.reduce((n, b) => n + b.count, 0)).toBe(1);
  });
});

describe('predicates', () => {
  const now = ms('2026-04-15T00:00:00Z');

  it('isActiveSubscription requires an allowed status AND a future expiry', () => {
    expect(isActiveSubscription(sub({ status: 'active', expiresAt: '2026-05-01T00:00:00Z' }), now)).toBe(true);
    expect(isActiveSubscription(sub({ status: 'grace_period', expiresAt: '2026-05-01T00:00:00Z' }), now)).toBe(true);
    // Right status, already expired — the guard against a missed EXPIRED webhook.
    expect(isActiveSubscription(sub({ status: 'active', expiresAt: '2026-04-01T00:00:00Z' }), now)).toBe(false);
    // on_hold is excluded: payment must be fixed before access returns.
    expect(isActiveSubscription(sub({ status: 'on_hold', expiresAt: '2026-05-01T00:00:00Z' }), now)).toBe(false);
    expect(isActiveSubscription(sub({ status: 'paused', expiresAt: '2026-05-01T00:00:00Z' }), now)).toBe(false);
  });

  it('isEndedSubscription covers expired and canceled only', () => {
    expect(isEndedSubscription(sub({ status: 'expired' }))).toBe(true);
    expect(isEndedSubscription(sub({ status: 'canceled' }))).toBe(true);
    expect(isEndedSubscription(sub({ status: 'active' }))).toBe(false);
    expect(isEndedSubscription(sub({ status: 'on_hold' }))).toBe(false);
  });

  it('isNonConsumable excludes consumables and subscriptions', () => {
    expect(isNonConsumable(purchase({ type: 'non_consumable' }))).toBe(true);
    expect(isNonConsumable(purchase({ type: 'consumable' }))).toBe(false);
    expect(isNonConsumable(purchase({ type: 'subscription' }))).toBe(false);
  });
});

describe('aggregateActive', () => {
  const now = ms('2026-04-15T00:00:00Z');

  it('counts entitled subscriptions and non-consumable purchases', () => {
    const subs = [
      sub({ status: 'active', expiresAt: '2026-05-01T00:00:00Z', productId: 'pro_monthly' }),
      sub({ status: 'grace_period', expiresAt: '2026-05-01T00:00:00Z', productId: 'pro_monthly' }),
      sub({ status: 'expired', expiresAt: '2026-04-01T00:00:00Z', productId: 'pro_yearly' }),
    ];
    const purchases = [
      purchase({ type: 'non_consumable', productId: 'lifetime_pass' }),
      purchase({ type: 'consumable', productId: 'coins_100' }),
    ];

    const result = aggregateActive(subs, purchases, now);

    expect(result.activeSubscriptions).toBe(2);
    expect(result.gracePeriodSubscriptions).toBe(1);
    expect(result.nonConsumablePurchases).toBe(1);
    expect(result.total).toBe(3); // 2 subs + 1 lifetime
  });

  it('keeps subscription and purchase product mixes separate', () => {
    const result = aggregateActive(
      [sub({ productId: 'pro_monthly' })],
      [purchase({ productId: 'lifetime_pass' })],
      now,
    );
    expect(result.byProduct).toEqual({ pro_monthly: 1 });
    expect(result.byProductPurchases).toEqual({ lifetime_pass: 1 });
  });

  it('merges platforms across subscriptions AND purchases', () => {
    // byPlatform answers "where are my paying users", which is not a per-kind
    // question — unlike the two product maps.
    const result = aggregateActive(
      [sub({ platform: 'apple' }), sub({ platform: 'google' })],
      [purchase({ platform: 'google' })],
      now,
    );
    expect(result.byPlatform).toEqual({ apple: 1, google: 2 });
  });

  it('returns zeroed counts and empty maps for an empty store', () => {
    const result = aggregateActive([], [], now);
    expect(result).toEqual({
      total: 0,
      activeSubscriptions: 0,
      gracePeriodSubscriptions: 0,
      nonConsumablePurchases: 0,
      byProduct: {},
      byProductPurchases: {},
      byPlatform: {},
    });
  });
});
