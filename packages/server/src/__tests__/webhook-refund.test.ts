/**
 * Refund / voided-purchase webhook tests.
 *
 * Covers:
 *   - Apple webhook REFUND for IAP (Consumable / Non-Consumable) →
 *     PurchaseStore row removed, SubscriptionStore untouched.
 *   - Apple webhook REFUND for subscriptions still updates SubscriptionStore.
 *   - Google voidedPurchaseNotification productType=2 → IAP row removed.
 *   - Google voidedPurchaseNotification productType=1 → subscription canceled.
 *   - decodeGoogleVoidedNotification recognises voided payload, ignores other kinds.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import type { OneSubServerConfig, PurchaseInfo, SubscriptionInfo } from '@onesub/shared';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';
import { createWebhookRouter } from '../routes/webhook.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';
import { decodeGoogleVoidedNotification } from '../providers/google.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

function appleConfig(): OneSubServerConfig {
  return {
    apple: { bundleId: 'com.example.app', skipJwsVerification: true },
    database: { url: '' },
  };
}

function googleConfig(): OneSubServerConfig {
  return {
    google: { packageName: 'com.example.app' },
    database: { url: '' },
  };
}

interface TestServer {
  request: (path: string, body: unknown) => Promise<{ status: number; body: unknown }>;
}

function buildServer(
  config: OneSubServerConfig,
  store: InMemorySubscriptionStore,
  purchaseStore: InMemoryPurchaseStore,
): TestServer {
  const app = express();
  app.use(express.json());
  app.use(createWebhookRouter(config, store, purchaseStore));

  return {
    async request(path, body) {
      // Use Node http directly for a lightweight test server.
      const server = app.listen(0);
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

const samplePurchase = (overrides?: Partial<PurchaseInfo>): PurchaseInfo => ({
  userId: 'user_1',
  productId: 'credits_100',
  platform: 'apple',
  type: 'consumable',
  transactionId: 'txn_apple_consumable_001',
  purchasedAt: '2026-01-01T00:00:00.000Z',
  quantity: 1,
  ...overrides,
});

const sampleSub = (overrides?: Partial<SubscriptionInfo>): SubscriptionInfo => ({
  userId: 'user_sub',
  productId: 'pro_monthly',
  platform: 'google',
  status: 'active',
  expiresAt: '2027-01-01T00:00:00.000Z',
  originalTransactionId: 'token_google_sub_xyz',
  purchasedAt: '2026-01-01T00:00:00.000Z',
  willRenew: true,
  ...overrides,
});

// ── Apple webhook: IAP REFUND ───────────────────────────────────────────────

describe('Apple webhook — IAP REFUND', () => {
  let store: InMemorySubscriptionStore;
  let purchaseStore: InMemoryPurchaseStore;
  let server: TestServer;

  beforeEach(() => {
    store = new InMemorySubscriptionStore();
    purchaseStore = new InMemoryPurchaseStore();
    server = buildServer(appleConfig(), store, purchaseStore);
  });

  it('removes the consumable purchase row on REFUND', async () => {
    await purchaseStore.savePurchase(samplePurchase({ transactionId: 'txn_consumable_a' }));

    const signedTransactionInfo = makeJws({
      bundleId: 'com.example.app',
      type: 'Consumable',
      productId: 'credits_100',
      transactionId: 'txn_consumable_a',
      originalTransactionId: 'orig_consumable_a',
      purchaseDate: Date.now(),
    });
    const signedRenewalInfo = makeJws({});
    const signedPayload = makeJws({
      notificationType: 'REFUND',
      data: { signedTransactionInfo, signedRenewalInfo },
    });

    const resp = await server.request('/onesub/webhook/apple', { signedPayload });
    expect(resp.status).toBe(200);
    expect(await purchaseStore.getPurchaseByTransactionId('txn_consumable_a')).toBeNull();
  });

  it('removes the non-consumable purchase row on REVOKE', async () => {
    await purchaseStore.savePurchase(samplePurchase({
      transactionId: 'txn_nc_a',
      type: 'non_consumable',
      productId: 'premium_unlock',
    }));

    const signedTransactionInfo = makeJws({
      bundleId: 'com.example.app',
      type: 'Non-Consumable',
      productId: 'premium_unlock',
      transactionId: 'txn_nc_a',
      originalTransactionId: 'txn_nc_a',
      purchaseDate: Date.now(),
    });
    const signedPayload = makeJws({
      notificationType: 'REVOKE',
      data: { signedTransactionInfo, signedRenewalInfo: makeJws({}) },
    });

    const resp = await server.request('/onesub/webhook/apple', { signedPayload });
    expect(resp.status).toBe(200);
    expect(await purchaseStore.getPurchaseByTransactionId('txn_nc_a')).toBeNull();
  });

  it('does not touch the SubscriptionStore on IAP REFUND', async () => {
    await store.save(sampleSub({ originalTransactionId: 'orig_sub_untouched' }));
    await purchaseStore.savePurchase(samplePurchase({ transactionId: 'iap_only' }));

    const signedTransactionInfo = makeJws({
      bundleId: 'com.example.app',
      type: 'Consumable',
      productId: 'credits_100',
      transactionId: 'iap_only',
      originalTransactionId: 'iap_only',
      purchaseDate: Date.now(),
    });
    const signedPayload = makeJws({
      notificationType: 'REFUND',
      data: { signedTransactionInfo, signedRenewalInfo: makeJws({}) },
    });

    await server.request('/onesub/webhook/apple', { signedPayload });
    expect(await store.getByTransactionId('orig_sub_untouched')).not.toBeNull();
  });

  it('still routes subscription REFUND through the SubscriptionStore', async () => {
    await store.save(sampleSub({
      platform: 'apple',
      originalTransactionId: 'orig_sub_apple',
      status: 'active',
    }));

    const signedTransactionInfo = makeJws({
      bundleId: 'com.example.app',
      type: 'Auto-Renewable Subscription',
      productId: 'pro_monthly',
      transactionId: 'tx_sub_apple_1',
      originalTransactionId: 'orig_sub_apple',
      purchaseDate: Date.now(),
      expiresDate: Date.now() + 86400000,
    });
    const signedPayload = makeJws({
      notificationType: 'REFUND',
      data: { signedTransactionInfo, signedRenewalInfo: makeJws({}) },
    });

    const resp = await server.request('/onesub/webhook/apple', { signedPayload });
    expect(resp.status).toBe(200);
    const updated = await store.getByTransactionId('orig_sub_apple');
    expect(updated?.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
  });
});

// ── Google webhook: voidedPurchaseNotification ──────────────────────────────

function makeVoidedPushBody(notification: {
  packageName: string;
  voidedPurchaseNotification: {
    purchaseToken: string;
    orderId: string;
    productType: 1 | 2;
    refundType: 1 | 2;
  };
}) {
  const json = JSON.stringify({
    version: '1.0',
    eventTimeMillis: String(Date.now()),
    ...notification,
  });
  return {
    message: {
      data: Buffer.from(json, 'utf-8').toString('base64'),
      messageId: '1',
    },
    subscription: 'projects/x/subscriptions/y',
  };
}

describe('Google webhook — voidedPurchaseNotification', () => {
  let store: InMemorySubscriptionStore;
  let purchaseStore: InMemoryPurchaseStore;
  let server: TestServer;

  beforeEach(() => {
    store = new InMemorySubscriptionStore();
    purchaseStore = new InMemoryPurchaseStore();
    server = buildServer(googleConfig(), store, purchaseStore);
  });

  it('removes IAP row when productType=2 (one-time product refund)', async () => {
    await purchaseStore.savePurchase(samplePurchase({
      platform: 'google',
      transactionId: 'GPA.refunded_order',
    }));

    const resp = await server.request(
      '/onesub/webhook/google',
      makeVoidedPushBody({
        packageName: 'com.example.app',
        voidedPurchaseNotification: {
          purchaseToken: 'tok_x',
          orderId: 'GPA.refunded_order',
          productType: 2,
          refundType: 1,
        },
      }),
    );
    expect(resp.status).toBe(200);
    expect(await purchaseStore.getPurchaseByTransactionId('GPA.refunded_order')).toBeNull();
  });

  it('cancels subscription when productType=1', async () => {
    await store.save(sampleSub({ originalTransactionId: 'tok_sub' }));

    const resp = await server.request(
      '/onesub/webhook/google',
      makeVoidedPushBody({
        packageName: 'com.example.app',
        voidedPurchaseNotification: {
          purchaseToken: 'tok_sub',
          orderId: 'GPA.sub_order',
          productType: 1,
          refundType: 1,
        },
      }),
    );
    expect(resp.status).toBe(200);
    const updated = await store.getByTransactionId('tok_sub');
    expect(updated?.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
  });

  it('rejects voided notification when packageName mismatches', async () => {
    const resp = await server.request(
      '/onesub/webhook/google',
      makeVoidedPushBody({
        packageName: 'com.attacker.app',
        voidedPurchaseNotification: {
          purchaseToken: 'tok',
          orderId: 'GPA.x',
          productType: 2,
          refundType: 1,
        },
      }),
    );
    expect(resp.status).toBe(400);
  });

  it('acknowledges with 200 even when the orderId is unknown', async () => {
    // Idempotent ack semantics — Google retries until 2xx; we don't want loops
    // when the row was already removed.
    const resp = await server.request(
      '/onesub/webhook/google',
      makeVoidedPushBody({
        packageName: 'com.example.app',
        voidedPurchaseNotification: {
          purchaseToken: 'tok',
          orderId: 'GPA.unknown',
          productType: 2,
          refundType: 1,
        },
      }),
    );
    expect(resp.status).toBe(200);
  });
});

// ── decodeGoogleVoidedNotification unit ─────────────────────────────────────

describe('decodeGoogleVoidedNotification', () => {
  it('returns null for subscription notifications', () => {
    const json = JSON.stringify({
      packageName: 'com.example.app',
      eventTimeMillis: '0',
      subscriptionNotification: {
        version: '1.0',
        notificationType: 4,
        purchaseToken: 't',
        subscriptionId: 'p',
      },
    });
    const result = decodeGoogleVoidedNotification({
      message: { data: Buffer.from(json).toString('base64'), messageId: '1' },
      subscription: 's',
    });
    expect(result).toBeNull();
  });

  it('extracts voided payload fields', () => {
    const json = JSON.stringify({
      packageName: 'com.example.app',
      eventTimeMillis: '0',
      voidedPurchaseNotification: {
        purchaseToken: 'tok123',
        orderId: 'GPA.xyz',
        productType: 2,
        refundType: 1,
      },
    });
    const result = decodeGoogleVoidedNotification({
      message: { data: Buffer.from(json).toString('base64'), messageId: '1' },
      subscription: 's',
    });
    expect(result).toEqual({
      purchaseToken: 'tok123',
      orderId: 'GPA.xyz',
      productType: 2,
      refundType: 1,
      packageName: 'com.example.app',
    });
  });

  it('returns null for malformed base64', () => {
    expect(decodeGoogleVoidedNotification({
      message: { data: '!!!not-base64!!!', messageId: '1' },
      subscription: 's',
    })).toBeNull();
  });
});
