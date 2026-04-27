/**
 * GET /onesub/admin/customers/:userId — per-user profile bundle.
 *
 * Backs the dashboard's customer detail page. Returns subscriptions +
 * purchases + entitlements (when configured) for one userId in a single
 * round-trip. Always 200 — unknown userIds yield empty arrays rather than
 * 404, since "no records yet" is a normal CS scenario.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import type {
  CustomerProfileResponse,
  EntitlementsConfig,
  OneSubServerConfig,
  PurchaseInfo,
  SubscriptionInfo,
} from '@onesub/shared';
import { createOneSubMiddleware, InMemorySubscriptionStore, InMemoryPurchaseStore } from '../index.js';

function sub(overrides?: Partial<SubscriptionInfo>): SubscriptionInfo {
  return {
    userId: 'u',
    productId: 'pro_monthly',
    platform: 'apple',
    status: 'active',
    expiresAt: '2099-01-01T00:00:00.000Z',
    purchasedAt: '2026-04-01T00:00:00.000Z',
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
    purchasedAt: '2026-04-01T00:00:00.000Z',
    quantity: 1,
    ...overrides,
  };
}

interface TestServer {
  get: <T,>(path: string, headers?: Record<string, string>) => Promise<{ status: number; body: T }>;
}

function spinUp(handler: express.Express): TestServer {
  return {
    async get<T>(path: string, headers?: Record<string, string>): Promise<{ status: number; body: T }> {
      const httpServer = handler.listen(0);
      const port = (httpServer.address() as { port: number }).port;
      try {
        const resp = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
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

function buildServer(opts: { adminSecret?: string; entitlements?: EntitlementsConfig }) {
  const store = new InMemorySubscriptionStore();
  const purchaseStore = new InMemoryPurchaseStore();
  const config: OneSubServerConfig = {
    apple: { bundleId: 'com.example.app', skipJwsVerification: true },
    database: { url: '' },
    adminSecret: opts.adminSecret,
    ...(opts.entitlements ? { entitlements: opts.entitlements } : {}),
  };
  const app = express();
  app.use(createOneSubMiddleware({ ...config, store, purchaseStore }));
  return { store, purchaseStore, server: spinUp(app) };
}

const SECRET = 's3cr3t';
const AUTH = { 'x-admin-secret': SECRET };

describe('GET /onesub/admin/customers/:userId auth', () => {
  it('returns 404 when adminSecret is unset (router not mounted)', async () => {
    const { server } = buildServer({});
    const resp = await server.get('/onesub/admin/customers/u_x');
    expect(resp.status).toBe(404);
  });

  it('returns 401 INVALID_ADMIN_SECRET when header is missing or wrong', async () => {
    const { server } = buildServer({ adminSecret: SECRET });

    const noHeader = await server.get<{ errorCode: string }>('/onesub/admin/customers/u_x');
    expect(noHeader.status).toBe(401);
    expect(noHeader.body.errorCode).toBe('INVALID_ADMIN_SECRET');
  });
});

describe('GET /onesub/admin/customers/:userId basics', () => {
  it('returns empty profile (200) for unknown userId', async () => {
    const { server } = buildServer({ adminSecret: SECRET });
    const resp = await server.get<CustomerProfileResponse>('/onesub/admin/customers/u_unknown', AUTH);

    expect(resp.status).toBe(200);
    expect(resp.body.userId).toBe('u_unknown');
    expect(resp.body.subscriptions).toEqual([]);
    expect(resp.body.purchases).toEqual([]);
    expect(resp.body.entitlements).toBeUndefined();
  });

  it('combines subscriptions and purchases for the user', async () => {
    const { store, purchaseStore, server } = buildServer({ adminSecret: SECRET });
    await store.save(sub({ userId: 'alice', productId: 'pro_monthly', originalTransactionId: 't1' }));
    await store.save(sub({ userId: 'alice', productId: 'pro_yearly',  originalTransactionId: 't2' }));
    // unrelated user — must NOT leak
    await store.save(sub({ userId: 'bob', originalTransactionId: 't_bob' }));
    await purchaseStore.savePurchase(purchase({ userId: 'alice', productId: 'lifetime', transactionId: 'p1' }));

    const resp = await server.get<CustomerProfileResponse>('/onesub/admin/customers/alice', AUTH);

    expect(resp.status).toBe(200);
    expect(resp.body.subscriptions).toHaveLength(2);
    expect(resp.body.subscriptions.every((s) => s.userId === 'alice')).toBe(true);
    expect(resp.body.purchases).toHaveLength(1);
    expect(resp.body.purchases[0]?.userId).toBe('alice');
  });
});

describe('GET /onesub/admin/customers/:userId entitlements', () => {
  it('omits entitlements when config.entitlements is unset', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    await store.save(sub({ userId: 'alice', originalTransactionId: 't1' }));

    const resp = await server.get<CustomerProfileResponse>('/onesub/admin/customers/alice', AUTH);

    expect(resp.body.entitlements).toBeUndefined();
  });

  it('evaluates each configured entitlement when entitlements are set', async () => {
    const { store, purchaseStore, server } = buildServer({
      adminSecret: SECRET,
      entitlements: {
        premium: { productIds: ['pro_monthly', 'pro_yearly'] },
        lifetime: { productIds: ['lifetime_pass'] },
      },
    });
    // Active sub matches "premium"
    await store.save(sub({ userId: 'alice', productId: 'pro_monthly', status: 'active', originalTransactionId: 't1' }));
    // Non-consumable matches "lifetime"
    await purchaseStore.savePurchase(purchase({ userId: 'alice', productId: 'lifetime_pass', transactionId: 'p1' }));

    const resp = await server.get<CustomerProfileResponse>('/onesub/admin/customers/alice', AUTH);

    expect(resp.body.entitlements?.premium?.active).toBe(true);
    expect(resp.body.entitlements?.premium?.source).toBe('subscription');
    expect(resp.body.entitlements?.lifetime?.active).toBe(true);
    expect(resp.body.entitlements?.lifetime?.source).toBe('purchase');
  });

  it('reports inactive entitlements when nothing matches', async () => {
    const { server } = buildServer({
      adminSecret: SECRET,
      entitlements: { premium: { productIds: ['pro_monthly'] } },
    });

    const resp = await server.get<CustomerProfileResponse>('/onesub/admin/customers/u_empty', AUTH);

    expect(resp.body.entitlements?.premium?.active).toBe(false);
    expect(resp.body.entitlements?.premium?.source).toBeNull();
  });
});
