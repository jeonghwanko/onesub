/**
 * Read-only metrics endpoints — admin-gated aggregations over Subscription +
 * PurchaseStore data.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import type {
  MetricsActiveResponse,
  MetricsCountResponse,
  OneSubServerConfig,
  PurchaseInfo,
  SubscriptionInfo,
} from '@onesub/shared';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';
import { createOneSubMiddleware, InMemorySubscriptionStore, InMemoryPurchaseStore } from '../index.js';

// ── helpers ─────────────────────────────────────────────────────────────────

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

function buildServer(opts: { adminSecret?: string; subs?: SubscriptionInfo[]; purchases?: PurchaseInfo[] }) {
  const store = new InMemorySubscriptionStore();
  const purchaseStore = new InMemoryPurchaseStore();
  const config: OneSubServerConfig = {
    apple: { bundleId: 'com.example.app', skipJwsVerification: true },
    database: { url: '' },
    adminSecret: opts.adminSecret,
  };
  const app = express();
  app.use(createOneSubMiddleware({ ...config, store, purchaseStore }));
  return { store, purchaseStore, server: spinUp(app) };
}

const SECRET = 's3cr3t';
const AUTH = { 'x-admin-secret': SECRET };

// ─────────────────────────────────────────────────────────────────────────────
// Auth gate
// ─────────────────────────────────────────────────────────────────────────────

describe('Metrics auth', () => {
  it('returns 404 (router not mounted) when adminSecret is unset', async () => {
    const { server } = buildServer({});
    const resp = await server.get<unknown>('/onesub/metrics/active');
    expect(resp.status).toBe(404);
  });

  it('returns 401 INVALID_ADMIN_SECRET when header is missing or wrong', async () => {
    const { server } = buildServer({ adminSecret: SECRET });

    const noHeader = await server.get<{ errorCode: string }>('/onesub/metrics/active');
    expect(noHeader.status).toBe(401);
    expect(noHeader.body.errorCode).toBe('INVALID_ADMIN_SECRET');

    const wrongHeader = await server.get<{ errorCode: string }>(
      '/onesub/metrics/active',
      { 'x-admin-secret': 'wrong' },
    );
    expect(wrongHeader.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /onesub/metrics/active
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /onesub/metrics/active', () => {
  it('returns zeros for an empty store', async () => {
    const { server } = buildServer({ adminSecret: SECRET });
    const resp = await server.get<MetricsActiveResponse>('/onesub/metrics/active', AUTH);
    expect(resp.status).toBe(200);
    expect(resp.body).toEqual({
      total: 0,
      activeSubscriptions: 0,
      gracePeriodSubscriptions: 0,
      nonConsumablePurchases: 0,
      byProduct: {},
      byPlatform: {},
    });
  });

  it('counts active subs + non-consumable purchases', async () => {
    const { store, purchaseStore, server } = buildServer({ adminSecret: SECRET });
    await store.save(sub({ userId: 'a', productId: 'pro_monthly', platform: 'apple' }));
    await store.save(sub({ userId: 'b', productId: 'pro_yearly', platform: 'google' }));
    await purchaseStore.savePurchase(purchase({ userId: 'c', platform: 'apple' }));

    const resp = await server.get<MetricsActiveResponse>('/onesub/metrics/active', AUTH);

    expect(resp.body.total).toBe(3);
    expect(resp.body.activeSubscriptions).toBe(2);
    expect(resp.body.nonConsumablePurchases).toBe(1);
    expect(resp.body.byProduct).toEqual({ pro_monthly: 1, pro_yearly: 1 });  // purchases not in byProduct
    expect(resp.body.byPlatform).toEqual({ apple: 2, google: 1 });
  });

  it('grace_period subs counted in activeSubscriptions AND gracePeriodSubscriptions', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    await store.save(sub({ userId: 'a', status: 'active' }));
    await store.save(sub({ userId: 'b', status: 'grace_period' }));

    const resp = await server.get<MetricsActiveResponse>('/onesub/metrics/active', AUTH);

    expect(resp.body.activeSubscriptions).toBe(2);
    expect(resp.body.gracePeriodSubscriptions).toBe(1);
  });

  it('on_hold / paused / canceled / expired subs NOT counted', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    for (const status of ['on_hold', 'paused', 'canceled', 'expired'] as const) {
      await store.save(sub({ userId: status, status }));
    }
    await store.save(sub({ userId: 'real_active', status: 'active' }));

    const resp = await server.get<MetricsActiveResponse>('/onesub/metrics/active', AUTH);

    expect(resp.body.activeSubscriptions).toBe(1);
  });

  it('expired-by-time subs (status=active but expiresAt < now) NOT counted', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    await store.save(sub({ userId: 'past', status: 'active', expiresAt: '2024-01-01T00:00:00.000Z' }));
    await store.save(sub({ userId: 'future', status: 'active', expiresAt: '2099-01-01T00:00:00.000Z' }));

    const resp = await server.get<MetricsActiveResponse>('/onesub/metrics/active', AUTH);

    expect(resp.body.activeSubscriptions).toBe(1);
  });

  it('consumable purchases NOT counted (only non_consumable contribute)', async () => {
    const { purchaseStore, server } = buildServer({ adminSecret: SECRET });
    await purchaseStore.savePurchase(purchase({ userId: 'a', type: 'consumable' }));
    await purchaseStore.savePurchase(purchase({ userId: 'b', type: 'non_consumable' }));

    const resp = await server.get<MetricsActiveResponse>('/onesub/metrics/active', AUTH);

    expect(resp.body.nonConsumablePurchases).toBe(1);
    expect(resp.body.total).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /onesub/metrics/started
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /onesub/metrics/started', () => {
  it('counts subs with purchasedAt within the [from, to] window', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    await store.save(sub({ userId: 'before', purchasedAt: '2026-03-15T00:00:00Z' }));
    await store.save(sub({ userId: 'in1',    purchasedAt: '2026-04-01T00:00:00Z' }));
    await store.save(sub({ userId: 'in2',    purchasedAt: '2026-04-15T00:00:00Z' }));
    await store.save(sub({ userId: 'after',  purchasedAt: '2026-05-15T00:00:00Z' }));

    const resp = await server.get<MetricsCountResponse>(
      '/onesub/metrics/started?from=2026-04-01T00:00:00Z&to=2026-04-30T23:59:59Z',
      AUTH,
    );

    expect(resp.body.total).toBe(2);
    expect(resp.body.from).toBe('2026-04-01T00:00:00Z');
    expect(resp.body.to).toBe('2026-04-30T23:59:59Z');
  });

  it('aggregates by product and platform', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    await store.save(sub({ userId: 'a', productId: 'pro_monthly', platform: 'apple', purchasedAt: '2026-04-10T00:00:00Z' }));
    await store.save(sub({ userId: 'b', productId: 'pro_yearly', platform: 'google', purchasedAt: '2026-04-20T00:00:00Z' }));
    await store.save(sub({ userId: 'c', productId: 'pro_monthly', platform: 'google', purchasedAt: '2026-04-25T00:00:00Z' }));

    const resp = await server.get<MetricsCountResponse>(
      '/onesub/metrics/started?from=2026-04-01T00:00:00Z&to=2026-04-30T23:59:59Z',
      AUTH,
    );

    expect(resp.body.byProduct).toEqual({ pro_monthly: 2, pro_yearly: 1 });
    expect(resp.body.byPlatform).toEqual({ apple: 1, google: 2 });
  });

  it('400 INVALID_INPUT when from/to are missing or malformed', async () => {
    const { server } = buildServer({ adminSecret: SECRET });

    const missing = await server.get<{ errorCode: string }>('/onesub/metrics/started', AUTH);
    expect(missing.status).toBe(400);

    const malformed = await server.get<{ errorCode: string }>(
      '/onesub/metrics/started?from=not-a-date&to=2026-04-30T23:59:59Z',
      AUTH,
    );
    expect(malformed.status).toBe(400);

    const reversed = await server.get<{ errorCode: string }>(
      '/onesub/metrics/started?from=2026-05-01T00:00:00Z&to=2026-04-01T00:00:00Z',
      AUTH,
    );
    expect(reversed.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /onesub/metrics/expired
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /onesub/metrics/expired', () => {
  it('counts only subs where status ∈ {expired, canceled} AND expiresAt in window', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    // status active but expiresAt in window — NOT counted (not actually ended)
    await store.save(sub({ userId: 'still_active', status: 'active', expiresAt: '2026-04-15T00:00:00Z' }));
    // status expired, expiresAt in window — counted
    await store.save(sub({ userId: 'expired_in', status: 'expired', expiresAt: '2026-04-10T00:00:00Z' }));
    // status canceled (refund), expiresAt in window — counted
    await store.save(sub({ userId: 'canceled_in', status: 'canceled', expiresAt: '2026-04-20T00:00:00Z' }));
    // status expired but expiresAt before window
    await store.save(sub({ userId: 'expired_before', status: 'expired', expiresAt: '2026-03-01T00:00:00Z' }));

    const resp = await server.get<MetricsCountResponse>(
      '/onesub/metrics/expired?from=2026-04-01T00:00:00Z&to=2026-04-30T23:59:59Z',
      AUTH,
    );

    expect(resp.body.total).toBe(2);  // expired_in + canceled_in
  });

  it('returns 0 when nothing matches', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    await store.save(sub({ status: 'active' }));

    const resp = await server.get<MetricsCountResponse>(
      '/onesub/metrics/expired?from=2020-01-01T00:00:00Z&to=2020-12-31T23:59:59Z',
      AUTH,
    );

    expect(resp.body.total).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /onesub/metrics/{started,expired}?groupBy=day — daily bucketing
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /onesub/metrics/started?groupBy=day', () => {
  it('omits buckets when groupBy is not set (backwards compatible)', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    await store.save(sub({ purchasedAt: '2026-04-15T00:00:00Z' }));

    const resp = await server.get<MetricsCountResponse>(
      '/onesub/metrics/started?from=2026-04-01T00:00:00Z&to=2026-04-30T23:59:59Z',
      AUTH,
    );

    expect(resp.body.total).toBe(1);
    expect(resp.body.buckets).toBeUndefined();
  });

  it('returns one zero-filled bucket per UTC day across the window', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    // 3-day window: 2026-04-01 .. 2026-04-03 inclusive
    await store.save(sub({ userId: 'a', purchasedAt: '2026-04-01T03:00:00Z', originalTransactionId: 't1' }));
    await store.save(sub({ userId: 'b', purchasedAt: '2026-04-01T18:00:00Z', originalTransactionId: 't2' }));
    await store.save(sub({ userId: 'c', purchasedAt: '2026-04-03T12:00:00Z', originalTransactionId: 't3' }));

    const resp = await server.get<MetricsCountResponse>(
      '/onesub/metrics/started?from=2026-04-01T00:00:00Z&to=2026-04-03T23:59:59Z&groupBy=day',
      AUTH,
    );

    expect(resp.body.total).toBe(3);
    expect(resp.body.buckets).toEqual([
      { date: '2026-04-01', count: 2 },
      { date: '2026-04-02', count: 0 }, // gap day, zero-filled
      { date: '2026-04-03', count: 1 },
    ]);
  });

  it('snaps the first bucket to UTC midnight even when from is mid-day', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    await store.save(sub({ purchasedAt: '2026-04-01T20:00:00Z' }));

    const resp = await server.get<MetricsCountResponse>(
      // from is 2026-04-01T15:00:00Z — same UTC day as the record
      '/onesub/metrics/started?from=2026-04-01T15:00:00Z&to=2026-04-02T15:00:00Z&groupBy=day',
      AUTH,
    );

    expect(resp.body.buckets?.[0]?.date).toBe('2026-04-01');
    expect(resp.body.buckets?.[0]?.count).toBe(1);
  });

  it('400 when groupBy is not one of the allowed values', async () => {
    const { server } = buildServer({ adminSecret: SECRET });
    const resp = await server.get<{ errorCode: string }>(
      '/onesub/metrics/started?from=2026-04-01T00:00:00Z&to=2026-04-02T00:00:00Z&groupBy=hour',
      AUTH,
    );
    expect(resp.status).toBe(400);
  });
});

describe('GET /onesub/metrics/expired?groupBy=day', () => {
  it('buckets expired/canceled by expiresAt UTC date', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    await store.save(sub({ userId: 'e1', status: 'expired', expiresAt: '2026-04-01T03:00:00Z', originalTransactionId: 'x1' }));
    await store.save(sub({ userId: 'e2', status: 'canceled', expiresAt: '2026-04-03T20:00:00Z', originalTransactionId: 'x2' }));
    // active record in window — not counted
    await store.save(sub({ userId: 'a', status: 'active', expiresAt: '2026-04-02T00:00:00Z', originalTransactionId: 'x3' }));

    const resp = await server.get<MetricsCountResponse>(
      '/onesub/metrics/expired?from=2026-04-01T00:00:00Z&to=2026-04-03T23:59:59Z&groupBy=day',
      AUTH,
    );

    expect(resp.body.total).toBe(2);
    expect(resp.body.buckets).toEqual([
      { date: '2026-04-01', count: 1 },
      { date: '2026-04-02', count: 0 },
      { date: '2026-04-03', count: 1 },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Store listAll regression
// ─────────────────────────────────────────────────────────────────────────────

describe('Store listAll', () => {
  it('SubscriptionStore.listAll returns every record', async () => {
    const store = new InMemorySubscriptionStore();
    await store.save(sub({ userId: 'a', originalTransactionId: 't1' }));
    await store.save(sub({ userId: 'b', originalTransactionId: 't2' }));
    await store.save(sub({ userId: 'a', originalTransactionId: 't3' }));

    const all = await store.listAll();
    expect(all).toHaveLength(3);
  });

  it('PurchaseStore.listAll returns every record', async () => {
    const purchaseStore = new InMemoryPurchaseStore();
    await purchaseStore.savePurchase(purchase({ userId: 'a', transactionId: 'p1' }));
    await purchaseStore.savePurchase(purchase({ userId: 'b', transactionId: 'p2' }));

    const all = await purchaseStore.listAll();
    expect(all).toHaveLength(2);
  });
});
