/**
 * Tests for the new 'paused' SubscriptionStatus + Google webhook
 * SUBSCRIPTION_PAUSED notification handling.
 *
 * Background: Google supports user-voluntary pause (different from on_hold,
 * which is involuntary payment failure). Surfaced as a distinct status so
 * the host app can render the right UX ("재개 예정" vs "결제 정보 업데이트").
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import type { OneSubServerConfig, SubscriptionInfo } from '@onesub/shared';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';
import { createWebhookRouter } from '../routes/webhook.js';
import { createStatusRouter } from '../routes/status.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';

interface TestServer {
  request: (method: 'POST' | 'GET', path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
}

function spinUp(handler: express.Express): TestServer {
  return {
    async request(method, path, body) {
      const server = handler.listen(0);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      try {
        const init: RequestInit = { method };
        if (body !== undefined) {
          init.headers = { 'Content-Type': 'application/json' };
          init.body = JSON.stringify(body);
        }
        const resp = await fetch(`http://127.0.0.1:${port}${path}`, init);
        const text = await resp.text();
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* keep as text */ }
        return { status: resp.status, body: parsed };
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}

const sampleSub = (overrides?: Partial<SubscriptionInfo>): SubscriptionInfo => ({
  userId: 'user_pause',
  productId: 'pro_monthly',
  platform: 'google',
  status: 'active',
  expiresAt: '2099-01-01T00:00:00.000Z',
  originalTransactionId: 'tok_pause',
  purchasedAt: '2026-01-01T00:00:00.000Z',
  willRenew: true,
  ...overrides,
});

function googlePushBody(notificationType: number, purchaseToken = 'tok_pause') {
  const json = JSON.stringify({
    version: '1.0',
    packageName: 'com.example.app',
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: '1.0',
      notificationType,
      purchaseToken,
      subscriptionId: 'pro_monthly',
    },
  });
  return {
    message: { data: Buffer.from(json).toString('base64'), messageId: '1' },
    subscription: 's',
  };
}

// ── webhook PAUSED → status=paused ──────────────────────────────────────────

describe('Google webhook — SUBSCRIPTION_PAUSED (10)', () => {
  let store: InMemorySubscriptionStore;
  let server: TestServer;

  beforeEach(() => {
    const config: OneSubServerConfig = {
      google: { packageName: 'com.example.app' },  // no serviceAccountKey → no Play API re-fetch
      database: { url: '' },
    };
    store = new InMemorySubscriptionStore();
    const purchaseStore = new InMemoryPurchaseStore();
    const app = express();
    app.use(express.json());
    app.use(createWebhookRouter(config, store, purchaseStore));
    server = spinUp(app);
  });

  it('maps PAUSED notification to status=paused', async () => {
    await store.save(sampleSub({ originalTransactionId: 'tok_pause' }));

    const resp = await server.request('POST', '/onesub/webhook/google', googlePushBody(10));

    expect(resp.status).toBe(200);
    expect((await store.getByTransactionId('tok_pause'))?.status).toBe(SUBSCRIPTION_STATUS.PAUSED);
  });

  it('paused is distinct from on_hold (different lifecycle signal)', async () => {
    await store.save(sampleSub({ originalTransactionId: 'tok_a' }));
    await store.save(sampleSub({ userId: 'user_hold', originalTransactionId: 'tok_b' }));

    await server.request('POST', '/onesub/webhook/google', googlePushBody(10, 'tok_a'));  // PAUSED
    await server.request('POST', '/onesub/webhook/google', googlePushBody(5, 'tok_b'));   // ON_HOLD

    expect((await store.getByTransactionId('tok_a'))?.status).toBe(SUBSCRIPTION_STATUS.PAUSED);
    expect((await store.getByTransactionId('tok_b'))?.status).toBe(SUBSCRIPTION_STATUS.ON_HOLD);
  });

  it('SUBSCRIPTION_RESTARTED (7) recovers entitlement after PAUSED', async () => {
    await store.save(sampleSub({ originalTransactionId: 'tok_resume', status: 'paused' }));

    await server.request('POST', '/onesub/webhook/google', googlePushBody(7, 'tok_resume'));

    expect((await store.getByTransactionId('tok_resume'))?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
  });
});

// ── status route entitlement ────────────────────────────────────────────────

describe('status route — paused', () => {
  let store: InMemorySubscriptionStore;
  let server: TestServer;

  beforeEach(() => {
    store = new InMemorySubscriptionStore();
    const app = express();
    app.use(express.json());
    app.use(createStatusRouter(store));
    server = spinUp(app);
  });

  it('paused → active=false (entitlement revoked while paused)', async () => {
    await store.save(sampleSub({ userId: 'u_paused', status: 'paused' }));

    const resp = await server.request('GET', '/onesub/status?userId=u_paused');

    expect(resp.status).toBe(200);
    expect((resp.body as { active: boolean }).active).toBe(false);
    // subscription record still returned so the host can show "재개 예정" UX
    expect((resp.body as { subscription: SubscriptionInfo | null }).subscription?.status).toBe('paused');
  });
});
