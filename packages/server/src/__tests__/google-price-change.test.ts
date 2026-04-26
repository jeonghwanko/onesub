/**
 * Tests for Google webhook SUBSCRIPTION_PRICE_CHANGE_CONFIRMED (8) handling
 * + the onPriceChangeConfirmed hook.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import type { OneSubServerConfig, SubscriptionInfo, GooglePriceChangeContext } from '@onesub/shared';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';
import { createWebhookRouter } from '../routes/webhook.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';

interface TestServer {
  request: (path: string, body: unknown) => Promise<{ status: number; body: unknown }>;
}

function spinUp(handler: express.Express): TestServer {
  return {
    async request(path, body) {
      const server = handler.listen(0);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      try {
        const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
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
  userId: 'user_pc',
  productId: 'pro_monthly',
  platform: 'google',
  status: 'active',
  expiresAt: '2099-01-01T00:00:00.000Z',
  originalTransactionId: 'tok_pc',
  purchasedAt: '2026-01-01T00:00:00.000Z',
  willRenew: true,
  ...overrides,
});

function priceChangePushBody(purchaseToken = 'tok_pc') {
  const json = JSON.stringify({
    version: '1.0',
    packageName: 'com.example.app',
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: '1.0',
      notificationType: 8, // SUBSCRIPTION_PRICE_CHANGE_CONFIRMED
      purchaseToken,
      subscriptionId: 'pro_monthly',
    },
  });
  return {
    message: { data: Buffer.from(json).toString('base64'), messageId: '1' },
    subscription: 's',
  };
}

function buildServer(config: OneSubServerConfig): {
  store: InMemorySubscriptionStore;
  server: TestServer;
} {
  const store = new InMemorySubscriptionStore();
  const purchaseStore = new InMemoryPurchaseStore();
  const app = express();
  app.use(express.json());
  app.use(createWebhookRouter(config, store, purchaseStore));
  return { store, server: spinUp(app) };
}

describe('Google webhook — SUBSCRIPTION_PRICE_CHANGE_CONFIRMED (8)', () => {
  it('keeps status=active for the existing record', async () => {
    const { store, server } = buildServer({
      google: { packageName: 'com.example.app' },
      database: { url: '' },
    });
    await store.save(sampleSub({ originalTransactionId: 'tok_keep' }));

    const resp = await server.request('/onesub/webhook/google', priceChangePushBody('tok_keep'));

    expect(resp.status).toBe(200);
    expect((await store.getByTransactionId('tok_keep'))?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
  });

  it('invokes onPriceChangeConfirmed hook with correct context', async () => {
    const captured: GooglePriceChangeContext[] = [];
    const { store, server } = buildServer({
      google: {
        packageName: 'com.example.app',
        onPriceChangeConfirmed: (ctx) => {
          captured.push(ctx);
        },
      },
      database: { url: '' },
    });
    await store.save(sampleSub({ originalTransactionId: 'tok_hook' }));

    await server.request('/onesub/webhook/google', priceChangePushBody('tok_hook'));

    // Hook is fire-and-forget — give microtask queue a tick
    await new Promise((r) => setTimeout(r, 30));

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      purchaseToken: 'tok_hook',
      subscriptionId: 'pro_monthly',
      packageName: 'com.example.app',
    });
  });

  it('async hook is awaited internally without blocking the webhook response', async () => {
    let hookResolved = false;
    const { store, server } = buildServer({
      google: {
        packageName: 'com.example.app',
        onPriceChangeConfirmed: async () => {
          await new Promise((r) => setTimeout(r, 50));
          hookResolved = true;
        },
      },
      database: { url: '' },
    });
    await store.save(sampleSub({ originalTransactionId: 'tok_async' }));

    const start = Date.now();
    const resp = await server.request('/onesub/webhook/google', priceChangePushBody('tok_async'));
    const responseLatency = Date.now() - start;

    // Webhook returned 200 fast — host's slow hook didn't block
    expect(resp.status).toBe(200);
    expect(responseLatency).toBeLessThan(50);
    expect(hookResolved).toBe(false);

    // Hook still completes eventually
    await new Promise((r) => setTimeout(r, 80));
    expect(hookResolved).toBe(true);
  });

  it('hook errors are swallowed (webhook still returns 200)', async () => {
    const { store, server } = buildServer({
      google: {
        packageName: 'com.example.app',
        onPriceChangeConfirmed: () => {
          throw new Error('boom');
        },
      },
      database: { url: '' },
    });
    await store.save(sampleSub({ originalTransactionId: 'tok_throw' }));

    const resp = await server.request('/onesub/webhook/google', priceChangePushBody('tok_throw'));
    expect(resp.status).toBe(200);
  });

  it('does nothing extra when hook is not configured', async () => {
    const { store, server } = buildServer({
      google: { packageName: 'com.example.app' },
      database: { url: '' },
    });
    await store.save(sampleSub({ originalTransactionId: 'tok_nohook' }));

    const resp = await server.request('/onesub/webhook/google', priceChangePushBody('tok_nohook'));

    expect(resp.status).toBe(200);
    // Subscription still active — webhook didn't fail just because no hook
    expect((await store.getByTransactionId('tok_nohook'))?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
  });

  it('hook is NOT invoked for other notification types (e.g. DID_RENEW)', async () => {
    const hookSpy = vi.fn();
    const { store, server } = buildServer({
      google: {
        packageName: 'com.example.app',
        onPriceChangeConfirmed: hookSpy,
      },
      database: { url: '' },
    });
    await store.save(sampleSub({ originalTransactionId: 'tok_other' }));

    const renewBody = {
      message: {
        data: Buffer.from(JSON.stringify({
          version: '1.0',
          packageName: 'com.example.app',
          eventTimeMillis: String(Date.now()),
          subscriptionNotification: {
            version: '1.0',
            notificationType: 2, // SUBSCRIPTION_RENEWED
            purchaseToken: 'tok_other',
            subscriptionId: 'pro_monthly',
          },
        })).toString('base64'),
        messageId: '1',
      },
      subscription: 's',
    };

    await server.request('/onesub/webhook/google', renewBody);
    await new Promise((r) => setTimeout(r, 30));

    expect(hookSpy).not.toHaveBeenCalled();
  });
});
