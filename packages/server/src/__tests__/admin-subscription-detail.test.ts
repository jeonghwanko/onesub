/**
 * GET /onesub/admin/subscriptions/:transactionId — single-record detail.
 *
 * Backs the dashboard's subscription detail page. Same auth contract as the
 * other /onesub/admin/* endpoints (X-Admin-Secret header).
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import type { OneSubServerConfig, SubscriptionInfo } from '@onesub/shared';
import { createOneSubMiddleware, InMemorySubscriptionStore, InMemoryPurchaseStore } from '../index.js';

function sub(overrides?: Partial<SubscriptionInfo>): SubscriptionInfo {
  return {
    userId: 'u',
    productId: 'pro_monthly',
    platform: 'apple',
    status: 'active',
    expiresAt: '2099-01-01T00:00:00.000Z',
    purchasedAt: '2026-04-01T00:00:00.000Z',
    originalTransactionId: 'orig_default',
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

function buildServer(opts: { adminSecret?: string }) {
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

describe('GET /onesub/admin/subscriptions/:transactionId auth', () => {
  it('returns 404 when adminSecret is unset (router not mounted)', async () => {
    const { server } = buildServer({});
    const resp = await server.get('/onesub/admin/subscriptions/orig_xyz');
    expect(resp.status).toBe(404);
  });

  it('returns 401 INVALID_ADMIN_SECRET when header is missing or wrong', async () => {
    const { server } = buildServer({ adminSecret: SECRET });

    const noHeader = await server.get<{ errorCode: string }>('/onesub/admin/subscriptions/orig_xyz');
    expect(noHeader.status).toBe(401);
    expect(noHeader.body.errorCode).toBe('INVALID_ADMIN_SECRET');

    const wrongHeader = await server.get<{ errorCode: string }>(
      '/onesub/admin/subscriptions/orig_xyz',
      { 'x-admin-secret': 'wrong' },
    );
    expect(wrongHeader.status).toBe(401);
  });
});

describe('GET /onesub/admin/subscriptions/:transactionId basics', () => {
  it('returns the matching subscription', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    const target = sub({ userId: 'alice', originalTransactionId: 'orig_42' });
    await store.save(target);
    await store.save(sub({ userId: 'bob', originalTransactionId: 'orig_other' }));

    const resp = await server.get<SubscriptionInfo>(
      '/onesub/admin/subscriptions/orig_42',
      AUTH,
    );
    expect(resp.status).toBe(200);
    expect(resp.body.originalTransactionId).toBe('orig_42');
    expect(resp.body.userId).toBe('alice');
  });

  it('returns 404 TRANSACTION_NOT_FOUND when the id is unknown', async () => {
    const { server } = buildServer({ adminSecret: SECRET });
    const resp = await server.get<{ errorCode: string }>(
      '/onesub/admin/subscriptions/orig_does_not_exist',
      AUTH,
    );
    expect(resp.status).toBe(404);
    expect(resp.body.errorCode).toBe('TRANSACTION_NOT_FOUND');
  });

  it('does not collide with the list endpoint (no :transactionId)', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    await store.save(sub({ userId: 'a', originalTransactionId: 'orig_1' }));

    const list = await server.get<{ items: SubscriptionInfo[] }>(
      '/onesub/admin/subscriptions',
      AUTH,
    );
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
  });

  it('preserves Google-only fields (linkedPurchaseToken, autoResumeTime)', async () => {
    const { store, server } = buildServer({ adminSecret: SECRET });
    await store.save(sub({
      platform: 'google',
      status: 'paused',
      originalTransactionId: 'orig_google',
      linkedPurchaseToken: 'prev_token',
      autoResumeTime: '2026-05-01T00:00:00.000Z',
    }));

    const resp = await server.get<SubscriptionInfo>(
      '/onesub/admin/subscriptions/orig_google',
      AUTH,
    );
    expect(resp.status).toBe(200);
    expect(resp.body.linkedPurchaseToken).toBe('prev_token');
    expect(resp.body.autoResumeTime).toBe('2026-05-01T00:00:00.000Z');
  });
});
