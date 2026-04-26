/**
 * GET /onesub/admin/subscriptions — filtered/paginated list endpoint.
 *
 * Backs the dashboard's subscriptions page; gated behind adminSecret like
 * the other /onesub/admin/* and /onesub/metrics/* endpoints.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import type {
  ListSubscriptionsResponse,
  OneSubServerConfig,
  SubscriptionInfo,
} from '@onesub/shared';
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

function buildServer(opts: { adminSecret?: string; subs?: SubscriptionInfo[] }) {
  const store = new InMemorySubscriptionStore();
  const purchaseStore = new InMemoryPurchaseStore();
  const config: OneSubServerConfig = {
    apple: { bundleId: 'com.example.app', skipJwsVerification: true },
    database: { url: '' },
    adminSecret: opts.adminSecret,
  };
  const app = express();
  app.use(createOneSubMiddleware({ ...config, store, purchaseStore }));
  return { store, server: spinUp(app) };
}

const SECRET = 's3cr3t';
const AUTH = { 'x-admin-secret': SECRET };

// ── auth ────────────────────────────────────────────────────────────────────

describe('GET /onesub/admin/subscriptions auth', () => {
  it('returns 404 when adminSecret is unset (router not mounted)', async () => {
    const { server } = buildServer({});
    const resp = await server.get<unknown>('/onesub/admin/subscriptions');
    expect(resp.status).toBe(404);
  });

  it('returns 401 INVALID_ADMIN_SECRET when header is missing or wrong', async () => {
    const { server } = buildServer({ adminSecret: SECRET });

    const noHeader = await server.get<{ errorCode: string }>('/onesub/admin/subscriptions');
    expect(noHeader.status).toBe(401);
    expect(noHeader.body.errorCode).toBe('INVALID_ADMIN_SECRET');

    const wrongHeader = await server.get<{ errorCode: string }>(
      '/onesub/admin/subscriptions',
      { 'x-admin-secret': 'wrong' },
    );
    expect(wrongHeader.status).toBe(401);
  });
});

// ── basic listing ───────────────────────────────────────────────────────────

describe('GET /onesub/admin/subscriptions basics', () => {
  it('returns empty list with total=0 for an empty store', async () => {
    const { server } = buildServer({ adminSecret: SECRET });
    const resp = await server.get<ListSubscriptionsResponse>('/onesub/admin/subscriptions', AUTH);
    expect(resp.status).toBe(200);
    expect(resp.body.items).toEqual([]);
    expect(resp.body.total).toBe(0);
    expect(resp.body.limit).toBe(50);
    expect(resp.body.offset).toBe(0);
  });

  it('returns all subs when no filter is passed', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    await store.save(sub({ userId: 'a', originalTransactionId: 't1' }));
    await store.save(sub({ userId: 'b', originalTransactionId: 't2' }));
    await store.save(sub({ userId: 'c', originalTransactionId: 't3' }));

    const resp = await server.get<ListSubscriptionsResponse>('/onesub/admin/subscriptions', AUTH);
    expect(resp.body.total).toBe(3);
    expect(resp.body.items).toHaveLength(3);
  });
});

// ── filters ─────────────────────────────────────────────────────────────────

describe('GET /onesub/admin/subscriptions filters', () => {
  it('filters by userId', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    await store.save(sub({ userId: 'a', originalTransactionId: 't1' }));
    await store.save(sub({ userId: 'b', originalTransactionId: 't2' }));
    await store.save(sub({ userId: 'a', originalTransactionId: 't3' }));

    const resp = await server.get<ListSubscriptionsResponse>(
      '/onesub/admin/subscriptions?userId=a',
      AUTH,
    );
    expect(resp.body.total).toBe(2);
    expect(resp.body.items.every((s) => s.userId === 'a')).toBe(true);
  });

  it('filters by status', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    await store.save(sub({ userId: 'a', status: 'active', originalTransactionId: 't1' }));
    await store.save(sub({ userId: 'b', status: 'expired', originalTransactionId: 't2' }));
    await store.save(sub({ userId: 'c', status: 'active', originalTransactionId: 't3' }));
    await store.save(sub({ userId: 'd', status: 'paused', originalTransactionId: 't4' }));

    const active = await server.get<ListSubscriptionsResponse>(
      '/onesub/admin/subscriptions?status=active',
      AUTH,
    );
    expect(active.body.total).toBe(2);

    const paused = await server.get<ListSubscriptionsResponse>(
      '/onesub/admin/subscriptions?status=paused',
      AUTH,
    );
    expect(paused.body.total).toBe(1);
  });

  it('filters by productId + platform combined (AND)', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    await store.save(sub({ userId: 'a', productId: 'pro_monthly', platform: 'apple', originalTransactionId: 't1' }));
    await store.save(sub({ userId: 'b', productId: 'pro_yearly', platform: 'apple', originalTransactionId: 't2' }));
    await store.save(sub({ userId: 'c', productId: 'pro_monthly', platform: 'google', originalTransactionId: 't3' }));

    const resp = await server.get<ListSubscriptionsResponse>(
      '/onesub/admin/subscriptions?productId=pro_monthly&platform=apple',
      AUTH,
    );
    expect(resp.body.total).toBe(1);
    expect(resp.body.items[0].userId).toBe('a');
  });

  it('rejects unknown status with 400', async () => {
    const { server } = buildServer({ adminSecret: SECRET });
    const resp = await server.get<{ errorCode?: string }>(
      '/onesub/admin/subscriptions?status=zombie',
      AUTH,
    );
    expect(resp.status).toBe(400);
  });

  it('rejects unknown platform with 400', async () => {
    const { server } = buildServer({ adminSecret: SECRET });
    const resp = await server.get<{ errorCode?: string }>(
      '/onesub/admin/subscriptions?platform=amazon',
      AUTH,
    );
    expect(resp.status).toBe(400);
  });
});

// ── pagination ──────────────────────────────────────────────────────────────

describe('GET /onesub/admin/subscriptions pagination', () => {
  it('respects limit and offset', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    for (let i = 0; i < 7; i++) {
      await store.save(sub({ userId: `u${i}`, originalTransactionId: `t${i}` }));
    }

    const page1 = await server.get<ListSubscriptionsResponse>(
      '/onesub/admin/subscriptions?limit=3&offset=0',
      AUTH,
    );
    expect(page1.body.items).toHaveLength(3);
    expect(page1.body.total).toBe(7);
    expect(page1.body.limit).toBe(3);

    const page2 = await server.get<ListSubscriptionsResponse>(
      '/onesub/admin/subscriptions?limit=3&offset=3',
      AUTH,
    );
    expect(page2.body.items).toHaveLength(3);
    expect(page2.body.offset).toBe(3);

    const page3 = await server.get<ListSubscriptionsResponse>(
      '/onesub/admin/subscriptions?limit=3&offset=6',
      AUTH,
    );
    expect(page3.body.items).toHaveLength(1);
  });

  it('caps limit at 200 (zod refuses larger values)', async () => {
    const { server } = buildServer({ adminSecret: SECRET });
    const resp = await server.get<{ errorCode?: string }>(
      '/onesub/admin/subscriptions?limit=999',
      AUTH,
    );
    expect(resp.status).toBe(400);
  });

  it('rejects negative offset', async () => {
    const { server } = buildServer({ adminSecret: SECRET });
    const resp = await server.get<{ errorCode?: string }>(
      '/onesub/admin/subscriptions?offset=-1',
      AUTH,
    );
    expect(resp.status).toBe(400);
  });
});

// ── store.listFiltered direct (bypass HTTP) ─────────────────────────────────

describe('InMemorySubscriptionStore.listFiltered', () => {
  let store: InMemorySubscriptionStore;

  beforeEach(() => {
    store = new InMemorySubscriptionStore();
  });

  it('combines all four filters with AND semantics', async () => {
    await store.save(sub({ userId: 'a', productId: 'pro', platform: 'apple', status: 'active', originalTransactionId: 't1' }));
    await store.save(sub({ userId: 'a', productId: 'pro', platform: 'google', status: 'active', originalTransactionId: 't2' }));
    await store.save(sub({ userId: 'a', productId: 'pro', platform: 'apple', status: 'expired', originalTransactionId: 't3' }));

    const result = await store.listFiltered({
      userId: 'a',
      productId: 'pro',
      platform: 'apple',
      status: 'active',
    });
    expect(result.total).toBe(1);
    expect(result.items[0].originalTransactionId).toBe('t1');
  });

  it('defaults to limit=50, offset=0', async () => {
    await store.save(sub());
    const result = await store.listFiltered({});
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
  });
});
