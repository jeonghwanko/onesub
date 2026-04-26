/**
 * Tests for Google linkedPurchaseToken upgrade/downgrade chain handling.
 *
 * - validateGoogleReceipt surfaces linkedPurchaseToken from v2 response
 * - webhook for an unknown new token with linkedPurchaseToken inherits the
 *   userId from the previous record (continuity across plan changes)
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { generateKeyPairSync } from 'crypto';
import type { OneSubServerConfig, SubscriptionInfo } from '@onesub/shared';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';
import { validateGoogleReceipt } from '../providers/google.js';
import { createWebhookRouter } from '../routes/webhook.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';
import { isLocalhostUrl, urlHost } from './test-utils.js';

let testPrivateKey: string;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  testPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
});

beforeEach(() => {
  vi.restoreAllMocks();
});

function googleConfig(extra?: Partial<NonNullable<OneSubServerConfig['google']>>): NonNullable<OneSubServerConfig['google']> {
  return {
    packageName: 'com.example.app',
    serviceAccountKey: JSON.stringify({
      client_email: `test-${Math.random()}@test.iam.gserviceaccount.com`,
      private_key: testPrivateKey,
      token_uri: 'https://oauth2.googleapis.com/token',
    }),
    ...extra,
  };
}

interface V2Response {
  startTime?: string;
  subscriptionState?: string;
  latestOrderId?: string;
  linkedPurchaseToken?: string;
  lineItems?: Array<{
    productId?: string;
    expiryTime?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean };
  }>;
}

function v2Response(opts: Partial<V2Response> & { productId?: string }): V2Response {
  return {
    startTime: '2026-01-01T00:00:00Z',
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
    latestOrderId: 'GPA.new_order',
    lineItems: [{
      productId: opts.productId ?? 'pro_yearly',
      expiryTime: '2027-01-01T00:00:00Z',
      autoRenewingPlan: { autoRenewEnabled: true },
    }],
    ...opts,
  };
}

function mockV2Fetch(responseBody: V2Response) {
  const originalFetch = global.fetch;
  vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    if (isLocalhostUrl(url)) return originalFetch(url, init);
    const host = urlHost(url);
    if (host === 'oauth2.googleapis.com') {
      return {
        ok: true,
        json: async () => ({ access_token: 'tok', expires_in: 3600 }),
        text: async () => '',
      } as Response;
    }
    if (host === 'androidpublisher.googleapis.com') {
      return {
        ok: true,
        json: async () => responseBody,
        text: async () => JSON.stringify(responseBody),
      } as Response;
    }
    throw new Error(`[test] Unexpected URL: ${String(url)}`);
  });
}

// ── validateGoogleReceipt surfaces linkedPurchaseToken ──────────────────────

describe('validateGoogleReceipt — linkedPurchaseToken passthrough', () => {
  it('returns linkedPurchaseToken from the v2 response', async () => {
    mockV2Fetch(v2Response({
      productId: 'pro_yearly',
      linkedPurchaseToken: 'tok_old_monthly',
    }));

    const result = await validateGoogleReceipt('tok_new_yearly', 'pro_yearly', googleConfig());

    expect(result?.linkedPurchaseToken).toBe('tok_old_monthly');
  });

  it('returns undefined linkedPurchaseToken for first-purchase (no chain)', async () => {
    mockV2Fetch(v2Response({ productId: 'pro_monthly' }));  // no linkedPurchaseToken

    const result = await validateGoogleReceipt('tok_first', 'pro_monthly', googleConfig());

    expect(result?.linkedPurchaseToken).toBeUndefined();
  });
});

// ── webhook userId continuity via linkedPurchaseToken ───────────────────────

interface TestServer {
  request: (path: string, body: unknown) => Promise<{ status: number; body: unknown }>;
}

function spinUp(handler: express.Express): TestServer {
  return {
    async request(path, body) {
      const httpServer = handler.listen(0);
      const address = httpServer.address();
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
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    },
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

function purchasedNotificationBody(purchaseToken: string, productId = 'pro_yearly') {
  const json = JSON.stringify({
    version: '1.0',
    packageName: 'com.example.app',
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: '1.0',
      notificationType: 4,  // SUBSCRIPTION_PURCHASED
      purchaseToken,
      subscriptionId: productId,
    },
  });
  return {
    message: { data: Buffer.from(json).toString('base64'), messageId: '1' },
    subscription: 's',
  };
}

const sampleSub = (overrides?: Partial<SubscriptionInfo>): SubscriptionInfo => ({
  userId: 'real_user_42',
  productId: 'pro_monthly',
  platform: 'google',
  status: 'active',
  expiresAt: '2026-12-01T00:00:00.000Z',
  originalTransactionId: 'tok_old_monthly',
  purchasedAt: '2026-01-01T00:00:00.000Z',
  willRenew: true,
  ...overrides,
});

// Note: webhook saves the new record indexed by fresh.originalTransactionId
// (= v2 response's latestOrderId), not by purchaseToken. So the assertions
// look up new records via the latestOrderId from the mocked v2 response.
//
// History assertions (previous record) use the previous original_transaction_id
// (= the linkedPurchaseToken value, which is itself the prior latestOrderId).

describe('Google webhook — linkedPurchaseToken userId inheritance', () => {
  it('inherits userId from the previous (linked) record on plan change', async () => {
    mockV2Fetch(v2Response({
      productId: 'pro_yearly',
      latestOrderId: 'GPA.new_yearly_order',
      linkedPurchaseToken: 'tok_old_monthly',
    }));

    const { store, server } = buildServer({
      google: googleConfig(),
      database: { url: '' },
    });
    // Previous monthly subscription owned by real_user_42
    await store.save(sampleSub({ originalTransactionId: 'tok_old_monthly' }));

    const resp = await server.request('/onesub/webhook/google', purchasedNotificationBody('tok_new_yearly'));
    expect(resp.status).toBe(200);

    const newRecord = await store.getByTransactionId('GPA.new_yearly_order');
    expect(newRecord).not.toBeNull();
    expect(newRecord?.userId).toBe('real_user_42');  // inherited, not placeholder
    expect(newRecord?.productId).toBe('pro_yearly');
    expect(newRecord?.linkedPurchaseToken).toBe('tok_old_monthly');
    expect(newRecord?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
  });

  it('falls back to placeholder userId when linkedPurchaseToken record is unknown', async () => {
    mockV2Fetch(v2Response({
      productId: 'pro_yearly',
      latestOrderId: 'GPA.orphan_order',
      linkedPurchaseToken: 'tok_never_seen',
    }));

    const { store, server } = buildServer({
      google: googleConfig(),
      database: { url: '' },
    });
    // No previous record exists

    await server.request('/onesub/webhook/google', purchasedNotificationBody('tok_new_orphan'));

    const newRecord = await store.getByTransactionId('GPA.orphan_order');
    expect(newRecord?.userId).toBe('tok_new_orphan');  // placeholder = purchaseToken
  });

  it('uses placeholder userId when the new subscription has no linkedPurchaseToken (first purchase)', async () => {
    mockV2Fetch(v2Response({
      productId: 'pro_monthly',
      latestOrderId: 'GPA.first_order',
    }));  // no linkedPurchaseToken

    const { store, server } = buildServer({
      google: googleConfig(),
      database: { url: '' },
    });

    await server.request('/onesub/webhook/google', purchasedNotificationBody('tok_first_buy', 'pro_monthly'));

    const newRecord = await store.getByTransactionId('GPA.first_order');
    expect(newRecord?.userId).toBe('tok_first_buy');
  });

  it('preserves the previous record (history) when issuing the new one', async () => {
    mockV2Fetch(v2Response({
      productId: 'pro_yearly',
      latestOrderId: 'GPA.keep_new_order',
      linkedPurchaseToken: 'tok_old_keep',
    }));

    const { store, server } = buildServer({
      google: googleConfig(),
      database: { url: '' },
    });
    await store.save(sampleSub({ originalTransactionId: 'tok_old_keep', userId: 'user_keep' }));

    await server.request('/onesub/webhook/google', purchasedNotificationBody('tok_new_keep'));

    // Previous record still findable by its own originalTransactionId
    const previous = await store.getByTransactionId('tok_old_keep');
    expect(previous?.userId).toBe('user_keep');
    expect(previous?.productId).toBe('pro_monthly');

    // New record carries the inherited userId AND the link backward
    const next = await store.getByTransactionId('GPA.keep_new_order');
    expect(next?.userId).toBe('user_keep');
    expect(next?.linkedPurchaseToken).toBe('tok_old_keep');
  });
});
