/**
 * Tests for OneSubServerConfig.refundPolicy.
 *
 * Covers:
 *   - Default ('immediate'): subscription REFUND/REVOKE/voided sets status=canceled
 *   - 'until_expiry': keeps status + expiresAt, only flips willRenew=false
 *   - IAP refund is unaffected by refundPolicy (always immediate)
 *   - status route's stale-record check (active && expiresAt > now)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import type { OneSubServerConfig, SubscriptionInfo, PurchaseInfo } from '@onesub/shared';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';
import { createWebhookRouter } from '../routes/webhook.js';
import { createStatusRouter } from '../routes/status.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function makeJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

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
        const url = `http://127.0.0.1:${port}${path}`;
        const init: RequestInit = { method };
        if (body !== undefined) {
          init.headers = { 'Content-Type': 'application/json' };
          init.body = JSON.stringify(body);
        }
        const resp = await fetch(url, init);
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

function buildWebhookServer(config: OneSubServerConfig): {
  store: InMemorySubscriptionStore;
  purchaseStore: InMemoryPurchaseStore;
  server: TestServer;
} {
  const store = new InMemorySubscriptionStore();
  const purchaseStore = new InMemoryPurchaseStore();
  const app = express();
  app.use(express.json());
  app.use(createWebhookRouter(config, store, purchaseStore));
  return { store, purchaseStore, server: spinUp(app) };
}

function buildStatusServer(): { store: InMemorySubscriptionStore; server: TestServer } {
  const store = new InMemorySubscriptionStore();
  const app = express();
  app.use(express.json());
  app.use(createStatusRouter(store));
  return { store, server: spinUp(app) };
}

const futureExpiry = '2099-01-01T00:00:00.000Z';
const pastExpiry = '2024-01-01T00:00:00.000Z';

const sampleSub = (overrides?: Partial<SubscriptionInfo>): SubscriptionInfo => ({
  userId: 'user_x',
  productId: 'pro_monthly',
  platform: 'apple',
  status: 'active',
  expiresAt: futureExpiry,
  originalTransactionId: 'orig_x',
  purchasedAt: '2026-01-01T00:00:00.000Z',
  willRenew: true,
  ...overrides,
});

function appleSubRefundPayload(originalTransactionId: string): unknown {
  const signedTransactionInfo = makeJws({
    bundleId: 'com.example.app',
    type: 'Auto-Renewable Subscription',
    productId: 'pro_monthly',
    transactionId: 'tx_refund',
    originalTransactionId,
    purchaseDate: Date.now() - 30 * 86400000,
    expiresDate: Date.now() + 30 * 86400000,
  });
  return {
    signedPayload: makeJws({
      notificationType: 'REFUND',
      data: { signedTransactionInfo, signedRenewalInfo: makeJws({}) },
    }),
  };
}

function appleConsumableRefundPayload(transactionId: string): unknown {
  const signedTransactionInfo = makeJws({
    bundleId: 'com.example.app',
    type: 'Consumable',
    productId: 'credits_100',
    transactionId,
    originalTransactionId: transactionId,
    purchaseDate: Date.now(),
  });
  return {
    signedPayload: makeJws({
      notificationType: 'REFUND',
      data: { signedTransactionInfo, signedRenewalInfo: makeJws({}) },
    }),
  };
}

function googleVoidedSubPayload(purchaseToken: string): unknown {
  const json = JSON.stringify({
    version: '1.0',
    packageName: 'com.example.app',
    eventTimeMillis: String(Date.now()),
    voidedPurchaseNotification: {
      purchaseToken,
      orderId: 'GPA.refunded',
      productType: 1,
      refundType: 1,
    },
  });
  return {
    message: { data: Buffer.from(json).toString('base64'), messageId: '1' },
    subscription: 's',
  };
}

const appleConfig: NonNullable<OneSubServerConfig['apple']> = {
  bundleId: 'com.example.app',
  skipJwsVerification: true,
};
const googleConfig: NonNullable<OneSubServerConfig['google']> = {
  packageName: 'com.example.app',
};

// ── refundPolicy default ('immediate') ──────────────────────────────────────

describe('refundPolicy default (immediate) — Apple subscription REFUND', () => {
  let store: InMemorySubscriptionStore;
  let server: TestServer;

  beforeEach(() => {
    const built = buildWebhookServer({ apple: appleConfig, database: { url: '' } });
    store = built.store;
    server = built.server;
  });

  it('marks status=canceled on REFUND', async () => {
    await store.save(sampleSub({ originalTransactionId: 'orig_immed' }));
    const resp = await server.request('POST', '/onesub/webhook/apple', appleSubRefundPayload('orig_immed'));
    expect(resp.status).toBe(200);
    expect((await store.getByTransactionId('orig_immed'))?.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
  });
});

describe('refundPolicy default (immediate) — Google voided subscription', () => {
  it('marks status=canceled on voidedPurchaseNotification productType=1', async () => {
    const { store, server } = buildWebhookServer({ google: googleConfig, database: { url: '' } });
    await store.save(sampleSub({ platform: 'google', originalTransactionId: 'tok_immed' }));

    const resp = await server.request('POST', '/onesub/webhook/google', googleVoidedSubPayload('tok_immed'));
    expect(resp.status).toBe(200);
    expect((await store.getByTransactionId('tok_immed'))?.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
  });
});

// ── refundPolicy 'until_expiry' ─────────────────────────────────────────────

describe("refundPolicy 'until_expiry' — Apple subscription REFUND", () => {
  let store: InMemorySubscriptionStore;
  let server: TestServer;

  beforeEach(() => {
    const built = buildWebhookServer({
      apple: appleConfig,
      database: { url: '' },
      refundPolicy: 'until_expiry',
    });
    store = built.store;
    server = built.server;
  });

  it('keeps status=active and expiresAt; only flips willRenew=false', async () => {
    const original = sampleSub({
      originalTransactionId: 'orig_keep',
      status: 'active',
      expiresAt: futureExpiry,
      willRenew: true,
    });
    await store.save(original);

    await server.request('POST', '/onesub/webhook/apple', appleSubRefundPayload('orig_keep'));

    const updated = await store.getByTransactionId('orig_keep');
    expect(updated?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    expect(updated?.expiresAt).toBe(futureExpiry);
    expect(updated?.willRenew).toBe(false);
  });

  it('still routes Apple REVOKE the same way (refund-class signal)', async () => {
    await store.save(sampleSub({ originalTransactionId: 'orig_revoke' }));

    const signedTransactionInfo = makeJws({
      bundleId: 'com.example.app',
      type: 'Auto-Renewable Subscription',
      productId: 'pro_monthly',
      transactionId: 'tx_revoke',
      originalTransactionId: 'orig_revoke',
      purchaseDate: Date.now(),
      expiresDate: Date.now() + 86400000,
    });
    const signedPayload = makeJws({
      notificationType: 'REVOKE',
      data: { signedTransactionInfo, signedRenewalInfo: makeJws({}) },
    });

    await server.request('POST', '/onesub/webhook/apple', { signedPayload });

    const updated = await store.getByTransactionId('orig_revoke');
    expect(updated?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    expect(updated?.willRenew).toBe(false);
  });

  it('still applies normal expiry mapping for non-refund notifications (DID_RENEW)', async () => {
    await store.save(sampleSub({ originalTransactionId: 'orig_renew', willRenew: false }));

    const signedTransactionInfo = makeJws({
      bundleId: 'com.example.app',
      type: 'Auto-Renewable Subscription',
      productId: 'pro_monthly',
      transactionId: 'tx_renew',
      originalTransactionId: 'orig_renew',
      purchaseDate: Date.now(),
      expiresDate: Date.now() + 30 * 86400000,
    });
    const signedPayload = makeJws({
      notificationType: 'DID_RENEW',
      data: { signedTransactionInfo, signedRenewalInfo: makeJws({ autoRenewStatus: 1 }) },
    });

    await server.request('POST', '/onesub/webhook/apple', { signedPayload });

    const updated = await store.getByTransactionId('orig_renew');
    expect(updated?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    // willRenew should reflect the renewal info (true), not stay false
    expect(updated?.willRenew).toBe(true);
  });
});

describe("refundPolicy 'until_expiry' — Google voided subscription", () => {
  it('keeps status=active and only flips willRenew=false', async () => {
    const { store, server } = buildWebhookServer({
      google: googleConfig,
      database: { url: '' },
      refundPolicy: 'until_expiry',
    });
    await store.save(sampleSub({
      platform: 'google',
      originalTransactionId: 'tok_keep',
      status: 'active',
      willRenew: true,
    }));

    await server.request('POST', '/onesub/webhook/google', googleVoidedSubPayload('tok_keep'));

    const updated = await store.getByTransactionId('tok_keep');
    expect(updated?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    expect(updated?.willRenew).toBe(false);
  });
});

// ── IAP refund is unaffected by refundPolicy ────────────────────────────────

describe('refundPolicy does NOT apply to one-time IAP refunds', () => {
  const iap = (overrides?: Partial<PurchaseInfo>): PurchaseInfo => ({
    userId: 'u',
    productId: 'credits_100',
    platform: 'apple',
    type: 'consumable',
    transactionId: 'iap_tx',
    purchasedAt: '2026-01-01T00:00:00.000Z',
    quantity: 1,
    ...overrides,
  });

  it("Apple IAP REFUND removes the row even when refundPolicy='until_expiry'", async () => {
    const { purchaseStore, server } = buildWebhookServer({
      apple: appleConfig,
      database: { url: '' },
      refundPolicy: 'until_expiry',
    });
    await purchaseStore.savePurchase(iap({ transactionId: 'iap_keep_test' }));

    await server.request('POST', '/onesub/webhook/apple', appleConsumableRefundPayload('iap_keep_test'));

    expect(await purchaseStore.getPurchaseByTransactionId('iap_keep_test')).toBeNull();
  });

  it("Google voided IAP (productType=2) deletes the row even when refundPolicy='until_expiry'", async () => {
    const { purchaseStore, server } = buildWebhookServer({
      google: googleConfig,
      database: { url: '' },
      refundPolicy: 'until_expiry',
    });
    await purchaseStore.savePurchase(iap({ platform: 'google', transactionId: 'GPA.iap_keep' }));

    const json = JSON.stringify({
      version: '1.0',
      packageName: 'com.example.app',
      eventTimeMillis: String(Date.now()),
      voidedPurchaseNotification: {
        purchaseToken: 'tok',
        orderId: 'GPA.iap_keep',
        productType: 2,
        refundType: 1,
      },
    });
    await server.request('POST', '/onesub/webhook/google', {
      message: { data: Buffer.from(json).toString('base64'), messageId: '1' },
      subscription: 's',
    });

    expect(await purchaseStore.getPurchaseByTransactionId('GPA.iap_keep')).toBeNull();
  });
});

// ── status route stale-record safety ────────────────────────────────────────

describe('status route — stale active record', () => {
  it('returns active=false when status=active but expiresAt is in the past', async () => {
    const { store, server } = buildStatusServer();
    await store.save(sampleSub({ userId: 'u_stale', status: 'active', expiresAt: pastExpiry }));

    const resp = await server.request('GET', '/onesub/status?userId=u_stale');
    expect(resp.status).toBe(200);
    expect((resp.body as { active: boolean }).active).toBe(false);
  });

  it('returns active=true when status=active and expiresAt is in the future (normal case)', async () => {
    const { store, server } = buildStatusServer();
    await store.save(sampleSub({ userId: 'u_ok', status: 'active', expiresAt: futureExpiry }));

    const resp = await server.request('GET', '/onesub/status?userId=u_ok');
    expect((resp.body as { active: boolean }).active).toBe(true);
  });

  it('returns active=false for grace_period record past expiresAt', async () => {
    const { store, server } = buildStatusServer();
    await store.save(sampleSub({ userId: 'u_grace_stale', status: 'grace_period', expiresAt: pastExpiry }));

    const resp = await server.request('GET', '/onesub/status?userId=u_grace_stale');
    expect((resp.body as { active: boolean }).active).toBe(false);
  });
});
