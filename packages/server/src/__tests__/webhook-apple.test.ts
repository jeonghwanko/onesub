/**
 * Unit tests for webhook-apple.ts handler behaviors.
 *
 * Covers gaps not reached by lifecycle-scenarios or webhook-refund:
 *   - Input validation (missing / malformed signedPayload)
 *   - Webhook event deduplication via WebhookEventStore
 *   - DID_FAIL_TO_RENEW without GRACE_PERIOD subtype → on_hold
 *   - Notification type mappings: DID_RECOVER, OFFER_REDEEMED → active; EXPIRED → expired
 *   - Unknown notification type falls through to JWS transaction status
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import type { OneSubServerConfig, SubscriptionInfo } from '@onesub/shared';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';
import { createWebhookRouter } from '../routes/webhook.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';
import { InMemoryWebhookEventStore } from '../webhook-events.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

function applePayload(opts: {
  notificationType: string;
  subtype?: string;
  notificationUUID?: string;
  type?: string;
  originalTransactionId: string;
  transactionId?: string;
  expiresDate?: number;
  autoRenewStatus?: 0 | 1;
}): unknown {
  const signedTransactionInfo = makeJws({
    bundleId: 'com.example.app',
    type: opts.type ?? 'Auto-Renewable Subscription',
    productId: 'pro_monthly',
    transactionId: opts.transactionId ?? `tx_${Date.now()}`,
    originalTransactionId: opts.originalTransactionId,
    purchaseDate: Date.now() - 86400000,
    expiresDate: opts.expiresDate ?? Date.now() + 30 * 86400000,
    environment: 'Production',
  });
  const signedRenewalInfo = makeJws({ autoRenewStatus: opts.autoRenewStatus ?? 1 });
  const inner: Record<string, unknown> = {
    notificationType: opts.notificationType,
    data: { signedTransactionInfo, signedRenewalInfo },
  };
  if (opts.subtype) inner.subtype = opts.subtype;
  if (opts.notificationUUID) inner.notificationUUID = opts.notificationUUID;
  return { signedPayload: makeJws(inner) };
}

const baseConfig: OneSubServerConfig = {
  apple: { bundleId: 'com.example.app', skipJwsVerification: true },
  database: { url: '' },
};

const sampleSub = (overrides?: Partial<SubscriptionInfo>): SubscriptionInfo => ({
  userId: 'user_a',
  productId: 'pro_monthly',
  platform: 'apple',
  status: 'active',
  expiresAt: '2099-01-01T00:00:00.000Z',
  originalTransactionId: 'orig_a',
  purchasedAt: '2026-01-01T00:00:00.000Z',
  willRenew: true,
  ...overrides,
});

interface TestServer {
  request: (body: unknown) => Promise<{ status: number; body: unknown }>;
}

function buildServer(
  config: OneSubServerConfig,
  store: InMemorySubscriptionStore,
  webhookEventStore?: InMemoryWebhookEventStore,
): TestServer {
  const app = express();
  app.use(express.json());
  app.use(createWebhookRouter(config, store, new InMemoryPurchaseStore(), webhookEventStore));
  return {
    async request(body) {
      const srv = app.listen(0);
      const port = (srv.address() as { port: number }).port;
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/onesub/webhook/apple`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const text = await resp.text();
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* keep as text */ }
        return { status: resp.status, body: parsed };
      } finally {
        await new Promise<void>((r) => srv.close(() => r()));
      }
    },
  };
}

// ── Input validation ─────────────────────────────────────────────────────────

describe('Apple webhook — input validation', () => {
  it('returns 400 when signedPayload is missing', async () => {
    const store = new InMemorySubscriptionStore();
    const server = buildServer(baseConfig, store);

    const resp = await server.request({});
    expect(resp.status).toBe(400);
    expect((resp.body as { errorCode?: string }).errorCode).toBe('MISSING_SIGNED_PAYLOAD');
  });

  it('returns 400 when signedPayload is not a valid JWS', async () => {
    const store = new InMemorySubscriptionStore();
    const server = buildServer(baseConfig, store);

    // Not a 3-part dot-separated JWT — decodeJwt will throw
    const resp = await server.request({ signedPayload: 'not-a-jws-string' });
    expect(resp.status).toBe(400);
    expect((resp.body as { errorCode?: string }).errorCode).toBe('INVALID_SIGNED_PAYLOAD');
  });
});

// ── Deduplication ────────────────────────────────────────────────────────────

describe('Apple webhook — deduplication', () => {
  let store: InMemorySubscriptionStore;
  let webhookEventStore: InMemoryWebhookEventStore;
  let server: TestServer;

  beforeEach(() => {
    store = new InMemorySubscriptionStore();
    webhookEventStore = new InMemoryWebhookEventStore();
    server = buildServer(baseConfig, store, webhookEventStore);
  });

  it('processes the first delivery and returns received=true', async () => {
    await store.save(sampleSub({ originalTransactionId: 'orig_dedup' }));

    const resp = await server.request(applePayload({
      notificationType: 'DID_RENEW',
      notificationUUID: 'uuid-apple-1',
      originalTransactionId: 'orig_dedup',
    }));

    expect(resp.status).toBe(200);
    expect((resp.body as { received: boolean }).received).toBe(true);
    expect((resp.body as { deduped?: boolean }).deduped).toBeUndefined();
  });

  it('returns deduped=true and skips store update on replay', async () => {
    await store.save(sampleSub({ originalTransactionId: 'orig_dedup2', status: 'active' }));

    const payload = applePayload({
      notificationType: 'EXPIRED',
      notificationUUID: 'uuid-apple-2',
      originalTransactionId: 'orig_dedup2',
    });

    // First delivery — processed normally (EXPIRED → expired)
    await server.request(payload);
    expect((await store.getByTransactionId('orig_dedup2'))?.status).toBe(SUBSCRIPTION_STATUS.EXPIRED);

    // Restore status to simulate what a store rollback would look like
    await store.save(sampleSub({ originalTransactionId: 'orig_dedup2', status: 'active' }));

    // Replayed delivery — must be skipped, store stays 'active'
    const replay = await server.request(payload);
    expect(replay.status).toBe(200);
    expect((replay.body as { deduped: boolean }).deduped).toBe(true);
    expect((await store.getByTransactionId('orig_dedup2'))?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
  });

  it('does not deduplicate when no webhookEventStore is wired', async () => {
    // Without webhookEventStore, every delivery is processed regardless of UUID
    const serverNoDedup = buildServer(baseConfig, store);
    await store.save(sampleSub({ originalTransactionId: 'orig_nodedup' }));

    const payload = applePayload({
      notificationType: 'EXPIRED',
      notificationUUID: 'uuid-apple-3',
      originalTransactionId: 'orig_nodedup',
    });

    await serverNoDedup.request(payload);
    await store.save(sampleSub({ originalTransactionId: 'orig_nodedup', status: 'active' }));

    const second = await serverNoDedup.request(payload);
    expect(second.status).toBe(200);
    expect((second.body as { deduped?: boolean }).deduped).toBeUndefined();
    // Second delivery processed → status changed
    expect((await store.getByTransactionId('orig_nodedup'))?.status).toBe(SUBSCRIPTION_STATUS.EXPIRED);
  });
});

// ── Notification type → status mapping ──────────────────────────────────────

describe('Apple webhook — notification type mapping', () => {
  let store: InMemorySubscriptionStore;
  let server: TestServer;

  beforeEach(() => {
    store = new InMemorySubscriptionStore();
    server = buildServer(baseConfig, store);
  });

  it('DID_FAIL_TO_RENEW without subtype → on_hold', async () => {
    await store.save(sampleSub({ originalTransactionId: 'orig_fail' }));

    await server.request(applePayload({
      notificationType: 'DID_FAIL_TO_RENEW',
      originalTransactionId: 'orig_fail',
    }));

    expect((await store.getByTransactionId('orig_fail'))?.status).toBe(SUBSCRIPTION_STATUS.ON_HOLD);
  });

  it('DID_FAIL_TO_RENEW + GRACE_PERIOD subtype → grace_period', async () => {
    await store.save(sampleSub({ originalTransactionId: 'orig_grace' }));

    await server.request(applePayload({
      notificationType: 'DID_FAIL_TO_RENEW',
      subtype: 'GRACE_PERIOD',
      originalTransactionId: 'orig_grace',
    }));

    expect((await store.getByTransactionId('orig_grace'))?.status).toBe(SUBSCRIPTION_STATUS.GRACE_PERIOD);
  });

  it('DID_RECOVER → active', async () => {
    await store.save(sampleSub({ originalTransactionId: 'orig_recover', status: 'on_hold' }));

    await server.request(applePayload({
      notificationType: 'DID_RECOVER',
      originalTransactionId: 'orig_recover',
      expiresDate: Date.now() + 30 * 86400000,
    }));

    expect((await store.getByTransactionId('orig_recover'))?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
  });

  it('OFFER_REDEEMED → active', async () => {
    await store.save(sampleSub({ originalTransactionId: 'orig_offer', status: 'expired' }));

    await server.request(applePayload({
      notificationType: 'OFFER_REDEEMED',
      originalTransactionId: 'orig_offer',
      expiresDate: Date.now() + 30 * 86400000,
    }));

    expect((await store.getByTransactionId('orig_offer'))?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
  });

  it('EXPIRED → expired', async () => {
    await store.save(sampleSub({ originalTransactionId: 'orig_exp' }));

    await server.request(applePayload({
      notificationType: 'EXPIRED',
      originalTransactionId: 'orig_exp',
    }));

    expect((await store.getByTransactionId('orig_exp'))?.status).toBe(SUBSCRIPTION_STATUS.EXPIRED);
  });

  it('GRACE_PERIOD_EXPIRED → on_hold', async () => {
    await store.save(sampleSub({ originalTransactionId: 'orig_gpe', status: 'grace_period' }));

    await server.request(applePayload({
      notificationType: 'GRACE_PERIOD_EXPIRED',
      originalTransactionId: 'orig_gpe',
    }));

    expect((await store.getByTransactionId('orig_gpe'))?.status).toBe(SUBSCRIPTION_STATUS.ON_HOLD);
  });

  it('unknown notification type falls through to JWS transaction status', async () => {
    // JWS has autoRenewStatus=1 and a future expiresDate → provider decodes as ACTIVE.
    // The webhook maps unknown types to the decoded status.
    await store.save(sampleSub({ originalTransactionId: 'orig_unk', status: 'expired' }));

    await server.request(applePayload({
      notificationType: 'PRICE_INCREASE_CONSENT',  // not in any APPLE_*_TYPES set
      originalTransactionId: 'orig_unk',
      expiresDate: Date.now() + 30 * 86400000,
      autoRenewStatus: 1,
    }));

    // Status comes from the decoded JWS renewal info (active/grace_period based on expiresDate)
    // With a future expiresDate + autoRenewStatus=1, decodeAppleNotification returns active
    expect((await store.getByTransactionId('orig_unk'))?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
  });

  it('returns 200 even when originalTransactionId is unknown (no record in store)', async () => {
    // Webhook should always ack — not found means we can't recover without API creds,
    // but we still return 200 so Apple doesn't retry indefinitely.
    const resp = await server.request(applePayload({
      notificationType: 'DID_RENEW',
      originalTransactionId: 'completely_unknown',
    }));

    expect(resp.status).toBe(200);
    expect((resp.body as { received: boolean }).received).toBe(true);
  });
});
