/**
 * Entitlements abstraction tests.
 *
 * Covers:
 *   - evaluateEntitlement helper (subscription / purchase / mixed / none /
 *     expired sub / wrong status / consumable excluded)
 *   - GET /onesub/entitlement single-check route (404 unknown id, 400 bad input)
 *   - GET /onesub/entitlements bulk route
 *   - Router not mounted when config.entitlements is absent (404)
 *   - getAllByUserId returns multi-product subscriptions (regression for the
 *     InMemoryStore change that backs entitlements)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import type {
  EntitlementResponse,
  EntitlementsConfig,
  EntitlementsResponse,
  OneSubServerConfig,
  PurchaseInfo,
  SubscriptionInfo,
} from '@onesub/shared';
import { SUBSCRIPTION_STATUS, PURCHASE_TYPE } from '@onesub/shared';
import { createOneSubMiddleware } from '../index.js';
import { evaluateEntitlement } from '../routes/entitlements.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';

// ── helpers ─────────────────────────────────────────────────────────────────

const futureExpiry = '2099-01-01T00:00:00.000Z';
const pastExpiry = '2024-01-01T00:00:00.000Z';

function sub(overrides?: Partial<SubscriptionInfo>): SubscriptionInfo {
  return {
    userId: 'u',
    productId: 'pro_monthly',
    platform: 'apple',
    status: 'active',
    expiresAt: futureExpiry,
    originalTransactionId: `orig_${Math.random()}`,
    purchasedAt: '2026-01-01T00:00:00.000Z',
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
    purchasedAt: '2026-01-01T00:00:00.000Z',
    quantity: 1,
    ...overrides,
  };
}

interface TestServer {
  get: <T,>(path: string) => Promise<{ status: number; body: T }>;
}

function spinUp(handler: express.Express): TestServer {
  return {
    async get<T>(path: string): Promise<{ status: number; body: T }> {
      const httpServer = handler.listen(0);
      const port = (httpServer.address() as { port: number }).port;
      try {
        const resp = await fetch(`http://127.0.0.1:${port}${path}`);
        const text = await resp.text();
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* keep as text */ }
        return { status: resp.status, body: parsed as T };
      } finally {
        await new Promise<void>((r) => httpServer.close(() => r()));
      }
    },
  };
}

function buildServer(opts: {
  entitlements?: EntitlementsConfig;
  subs?: SubscriptionInfo[];
  purchases?: PurchaseInfo[];
}): {
  store: InMemorySubscriptionStore;
  purchaseStore: InMemoryPurchaseStore;
  server: TestServer;
} {
  const store = new InMemorySubscriptionStore();
  const purchaseStore = new InMemoryPurchaseStore();
  const config: OneSubServerConfig = {
    apple: { bundleId: 'com.example.app', skipJwsVerification: true },
    database: { url: '' },
    entitlements: opts.entitlements,
  };

  const app = express();
  // createOneSubMiddleware mounts express.json itself, but the entitlement
  // routes are GET-only so it's fine either way.
  const middleware = createOneSubMiddleware({ ...config, store, purchaseStore });
  app.use(middleware);

  return { store, purchaseStore, server: spinUp(app) };
}

const PREMIUM: EntitlementsConfig = {
  premium: { productIds: ['pro_monthly', 'pro_yearly', 'lifetime_pass'] },
};

// ─────────────────────────────────────────────────────────────────────────────
// evaluateEntitlement (unit, no HTTP)
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateEntitlement', () => {
  let store: InMemorySubscriptionStore;
  let purchaseStore: InMemoryPurchaseStore;

  beforeEach(() => {
    store = new InMemorySubscriptionStore();
    purchaseStore = new InMemoryPurchaseStore();
  });

  it('active subscription matching one of the productIds → entitled', async () => {
    await store.save(sub({ userId: 'u1', productId: 'pro_yearly' }));
    const result = await evaluateEntitlement('u1', PREMIUM.premium, store, purchaseStore);
    expect(result.active).toBe(true);
    expect(result.source).toBe('subscription');
    expect(result.productId).toBe('pro_yearly');
    expect(result.expiresAt).toBe(futureExpiry);
  });

  it('non-consumable purchase matching one of the productIds → entitled', async () => {
    await purchaseStore.savePurchase(purchase({ userId: 'u2', productId: 'lifetime_pass' }));
    const result = await evaluateEntitlement('u2', PREMIUM.premium, store, purchaseStore);
    expect(result.active).toBe(true);
    expect(result.source).toBe('purchase');
    expect(result.productId).toBe('lifetime_pass');
    expect(result.expiresAt).toBeUndefined();
  });

  it('no matching record → not entitled', async () => {
    const result = await evaluateEntitlement('u_none', PREMIUM.premium, store, purchaseStore);
    expect(result).toEqual({ active: false, source: null });
  });

  it('subscription preferred over purchase when both match', async () => {
    await store.save(sub({ userId: 'u3', productId: 'pro_monthly' }));
    await purchaseStore.savePurchase(purchase({ userId: 'u3', productId: 'lifetime_pass' }));
    const result = await evaluateEntitlement('u3', PREMIUM.premium, store, purchaseStore);
    expect(result.source).toBe('subscription');
    expect(result.productId).toBe('pro_monthly');
  });

  it('expired subscription (expiresAt < now) → not entitled even if status=active', async () => {
    await store.save(sub({ userId: 'u4', productId: 'pro_monthly', expiresAt: pastExpiry }));
    const result = await evaluateEntitlement('u4', PREMIUM.premium, store, purchaseStore);
    expect(result.active).toBe(false);
  });

  it('grace_period subscription → entitled (still has valid expiresAt)', async () => {
    await store.save(sub({ userId: 'u5', productId: 'pro_monthly', status: 'grace_period' }));
    const result = await evaluateEntitlement('u5', PREMIUM.premium, store, purchaseStore);
    expect(result.active).toBe(true);
    expect(result.source).toBe('subscription');
  });

  it('on_hold / paused / canceled / expired status → not entitled', async () => {
    for (const status of ['on_hold', 'paused', 'canceled', 'expired'] as const) {
      const localStore = new InMemorySubscriptionStore();
      await localStore.save(sub({ userId: 'u', productId: 'pro_monthly', status }));
      const result = await evaluateEntitlement('u', PREMIUM.premium, localStore, purchaseStore);
      expect(result.active).toBe(false);
    }
  });

  it('consumable purchase is NOT considered for entitlement', async () => {
    await purchaseStore.savePurchase(purchase({
      userId: 'u6',
      productId: 'pro_monthly',  // even matching productId
      type: 'consumable',
    }));
    const result = await evaluateEntitlement('u6', PREMIUM.premium, store, purchaseStore);
    expect(result.active).toBe(false);
  });

  it('multi-product subscriptions: returns the first matching active sub', async () => {
    // User has two subs — one for pro_yearly (matches), one for off-premium product (no match)
    await store.save(sub({ userId: 'u7', productId: 'unrelated_product' }));
    await store.save(sub({ userId: 'u7', productId: 'pro_yearly' }));
    const result = await evaluateEntitlement('u7', PREMIUM.premium, store, purchaseStore);
    expect(result.active).toBe(true);
    expect(result.productId).toBe('pro_yearly');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP routes
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /onesub/entitlement', () => {
  it('returns active=true when user has matching active sub', async () => {
    const { store, server } = buildServer({ entitlements: PREMIUM });
    await store.save(sub({ userId: 'u_yes', productId: 'pro_monthly' }));

    const resp = await server.get<EntitlementResponse>('/onesub/entitlement?userId=u_yes&id=premium');

    expect(resp.status).toBe(200);
    expect(resp.body.id).toBe('premium');
    expect(resp.body.active).toBe(true);
    expect(resp.body.source).toBe('subscription');
  });

  it('returns active=false when no matching record', async () => {
    const { server } = buildServer({ entitlements: PREMIUM });
    const resp = await server.get<EntitlementResponse>('/onesub/entitlement?userId=u_none&id=premium');
    expect(resp.status).toBe(200);
    expect(resp.body.active).toBe(false);
    expect(resp.body.source).toBeNull();
  });

  it('404 + ENTITLEMENT_NOT_FOUND for unknown id', async () => {
    const { server } = buildServer({ entitlements: PREMIUM });
    const resp = await server.get<{ errorCode: string }>('/onesub/entitlement?userId=u&id=enterprise');
    expect(resp.status).toBe(404);
    expect(resp.body.errorCode).toBe('ENTITLEMENT_NOT_FOUND');
  });

  it('400 INVALID_INPUT when userId or id is missing', async () => {
    const { server } = buildServer({ entitlements: PREMIUM });
    const resp = await server.get<{ errorCode: string }>('/onesub/entitlement?userId=u');
    expect(resp.status).toBe(400);
    expect(resp.body.errorCode).toBe('INVALID_INPUT');
  });
});

describe('GET /onesub/entitlements (bulk)', () => {
  it('evaluates every configured entitlement in one round-trip', async () => {
    const config: EntitlementsConfig = {
      premium: { productIds: ['pro_monthly', 'pro_yearly'] },
      promode: { productIds: ['dev_tools_addon'] },
    };
    const { store, server } = buildServer({ entitlements: config });
    await store.save(sub({ userId: 'u_bulk', productId: 'pro_yearly' }));

    const resp = await server.get<EntitlementsResponse>('/onesub/entitlements?userId=u_bulk');

    expect(resp.status).toBe(200);
    expect(resp.body.entitlements.premium.active).toBe(true);
    expect(resp.body.entitlements.premium.productId).toBe('pro_yearly');
    expect(resp.body.entitlements.promode.active).toBe(false);
  });

  it('returns empty entitlement statuses for a user with nothing', async () => {
    const config: EntitlementsConfig = {
      premium: { productIds: ['pro_monthly'] },
      addon: { productIds: ['some_addon'] },
    };
    const { server } = buildServer({ entitlements: config });

    const resp = await server.get<EntitlementsResponse>('/onesub/entitlements?userId=u_empty');

    expect(resp.body.entitlements.premium.active).toBe(false);
    expect(resp.body.entitlements.addon.active).toBe(false);
  });
});

describe('Entitlement routes are NOT mounted without config', () => {
  it('returns 404 when config.entitlements is absent', async () => {
    const { server } = buildServer({});  // no entitlements

    const resp = await server.get<unknown>('/onesub/entitlement?userId=u&id=premium');
    expect(resp.status).toBe(404);

    const respBulk = await server.get<unknown>('/onesub/entitlements?userId=u');
    expect(respBulk.status).toBe(404);
  });

  it('returns 404 when config.entitlements is empty {}', async () => {
    const { server } = buildServer({ entitlements: {} });
    const resp = await server.get<unknown>('/onesub/entitlement?userId=u&id=premium');
    expect(resp.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Store regression: getAllByUserId returns multi-product subs
// ─────────────────────────────────────────────────────────────────────────────

describe('InMemorySubscriptionStore — multi-sub per user (entitlement support)', () => {
  it('getAllByUserId returns all subs across productIds, latest first', async () => {
    const store = new InMemorySubscriptionStore();
    await store.save(sub({ userId: 'u', productId: 'pro_monthly', originalTransactionId: 'orig_a' }));
    await store.save(sub({ userId: 'u', productId: 'pro_yearly', originalTransactionId: 'orig_b' }));
    await store.save(sub({ userId: 'u', productId: 'addon', originalTransactionId: 'orig_c' }));

    const all = await store.getAllByUserId('u');
    expect(all.map((s) => s.productId)).toEqual(['addon', 'pro_yearly', 'pro_monthly']);
  });

  it('getByUserId still returns the most recent (legacy contract preserved)', async () => {
    const store = new InMemorySubscriptionStore();
    await store.save(sub({ userId: 'u', productId: 'pro_monthly', originalTransactionId: 'orig_a' }));
    await store.save(sub({ userId: 'u', productId: 'pro_yearly', originalTransactionId: 'orig_b' }));

    const latest = await store.getByUserId('u');
    expect(latest?.productId).toBe('pro_yearly');
  });

  it('save() with same originalTransactionId replaces prior record (no duplicates)', async () => {
    const store = new InMemorySubscriptionStore();
    await store.save(sub({
      userId: 'u', productId: 'pro_monthly', originalTransactionId: 'orig_x',
      status: 'active',
    }));
    await store.save(sub({
      userId: 'u', productId: 'pro_monthly', originalTransactionId: 'orig_x',
      status: 'canceled',
    }));

    const all = await store.getAllByUserId('u');
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe(SUBSCRIPTION_STATUS.CANCELED);
  });
});

// keep the import honest
PURCHASE_TYPE;
