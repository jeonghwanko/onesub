/**
 * Unit tests for webhook-google.ts handler behaviors.
 *
 * Covers gaps not reached by google-paused, google-price-change, or webhook-refund:
 *   - Input validation (missing message.data)
 *   - Webhook event deduplication via WebhookEventStore
 *   - pushAudience JWT authentication (missing / invalid token → 401)
 *   - Package name mismatch for subscription notifications
 *   - Notification type mappings: CANCELED, REVOKED, EXPIRED, IN_GRACE_PERIOD, unknown fallback
 *   - verifyGooglePushToken unit (no network required for invalid tokens)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import type { OneSubServerConfig, SubscriptionInfo } from '@onesub/shared';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';
import { createWebhookRouter } from '../routes/webhook.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';
import { InMemoryWebhookEventStore } from '../webhook-events.js';
import { verifyGooglePushToken } from '../routes/webhook-google.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function googlePushBody(notificationType: number, purchaseToken: string, opts?: {
  packageName?: string;
  messageId?: string;
}): unknown {
  const json = JSON.stringify({
    version: '1.0',
    packageName: opts?.packageName ?? 'com.example.app',
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: '1.0',
      notificationType,
      purchaseToken,
      subscriptionId: 'pro_monthly',
    },
  });
  return {
    message: {
      data: Buffer.from(json).toString('base64'),
      messageId: opts?.messageId ?? `msg-${Date.now()}`,
    },
    subscription: 'projects/x/subscriptions/y',
  };
}

const baseConfig: OneSubServerConfig = {
  google: { packageName: 'com.example.app' },
  database: { url: '' },
};

const sampleSub = (overrides?: Partial<SubscriptionInfo>): SubscriptionInfo => ({
  userId: 'user_g',
  productId: 'pro_monthly',
  platform: 'google',
  status: 'active',
  expiresAt: '2099-01-01T00:00:00.000Z',
  originalTransactionId: 'tok_g',
  purchasedAt: '2026-01-01T00:00:00.000Z',
  willRenew: true,
  ...overrides,
});

interface TestServer {
  request: (body: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: unknown }>;
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
    async request(body, headers) {
      const srv = app.listen(0);
      const port = (srv.address() as { port: number }).port;
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/onesub/webhook/google`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
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

describe('Google webhook — input validation', () => {
  it('returns 400 when message.data is missing', async () => {
    const store = new InMemorySubscriptionStore();
    const server = buildServer(baseConfig, store);

    const resp = await server.request({ message: { messageId: '1' }, subscription: 's' });
    expect(resp.status).toBe(400);
    expect((resp.body as { errorCode?: string }).errorCode).toBe('MISSING_MESSAGE_DATA');
  });

  it('returns 200 when message.data decodes to an unrecognized notification format', async () => {
    const store = new InMemorySubscriptionStore();
    const server = buildServer(baseConfig, store);

    // Valid base64 but payload has no known notification field
    const json = JSON.stringify({ version: '1.0', packageName: 'com.example.app' });
    const resp = await server.request({
      message: { data: Buffer.from(json).toString('base64'), messageId: '1' },
      subscription: 's',
    });
    // decodeGoogleNotification returns null → ack with 200
    expect(resp.status).toBe(200);
    expect((resp.body as { received: boolean }).received).toBe(true);
  });
});

// ── pushAudience authentication ───────────────────────────────────────────────

describe('Google webhook — pushAudience authentication', () => {
  const configWithAudience: OneSubServerConfig = {
    google: { packageName: 'com.example.app', pushAudience: 'https://myapp.example.com' },
    database: { url: '' },
  };

  it('returns 401 when Authorization header is absent', async () => {
    const store = new InMemorySubscriptionStore();
    const server = buildServer(configWithAudience, store);

    const resp = await server.request(googlePushBody(2, 'tok_auth'));
    expect(resp.status).toBe(401);
    expect((resp.body as { errorCode?: string }).errorCode).toBe('UNAUTHORIZED');
  });

  it('returns 401 when Bearer token is malformed (not a valid JWT)', async () => {
    const store = new InMemorySubscriptionStore();
    const server = buildServer(configWithAudience, store);

    const resp = await server.request(
      googlePushBody(2, 'tok_auth'),
      { Authorization: 'Bearer not-a-real-jwt' },
    );
    expect(resp.status).toBe(401);
    expect((resp.body as { errorCode?: string }).errorCode).toBe('UNAUTHORIZED');
  });

  it('passes through (processes notification) when no pushAudience is configured', async () => {
    const store = new InMemorySubscriptionStore();
    await store.save(sampleSub({ originalTransactionId: 'tok_noauth' }));
    const server = buildServer(baseConfig, store); // no pushAudience

    const resp = await server.request(googlePushBody(2, 'tok_noauth'));
    expect(resp.status).toBe(200);
  });
});

// ── verifyGooglePushToken unit ────────────────────────────────────────────────

describe('verifyGooglePushToken', () => {
  it('returns false when Authorization header is absent', async () => {
    const req = { headers: {} } as express.Request;
    expect(await verifyGooglePushToken(req, 'https://example.com')).toBe(false);
  });

  it('returns false when header is not Bearer scheme', async () => {
    const req = { headers: { authorization: 'Basic dXNlcjpwYXNz' } } as express.Request;
    expect(await verifyGooglePushToken(req, 'https://example.com')).toBe(false);
  });

  it('returns false for a malformed JWT that cannot be verified', async () => {
    // jose throws on invalid JWT format; verifyGooglePushToken catches and returns false
    const req = { headers: { authorization: 'Bearer not.valid.jwt' } } as express.Request;
    expect(await verifyGooglePushToken(req, 'https://example.com')).toBe(false);
  });
});

// ── Package name validation ───────────────────────────────────────────────────

describe('Google webhook — package name mismatch', () => {
  it('returns 400 when notification packageName does not match config', async () => {
    const store = new InMemorySubscriptionStore();
    const server = buildServer(baseConfig, store);

    const resp = await server.request(googlePushBody(2, 'tok_pkg', { packageName: 'com.attacker.app' }));
    expect(resp.status).toBe(400);
    expect((resp.body as { errorCode?: string }).errorCode).toBe('PACKAGE_NAME_MISMATCH');
  });

  it('accepts notification when no packageName is configured (open mode)', async () => {
    const openConfig: OneSubServerConfig = {
      google: {},  // no packageName restriction
      database: { url: '' },
    };
    const store = new InMemorySubscriptionStore();
    await store.save(sampleSub({ originalTransactionId: 'tok_open' }));
    const server = buildServer(openConfig, store);

    const resp = await server.request(googlePushBody(2, 'tok_open', { packageName: 'any.package.name' }));
    expect(resp.status).toBe(200);
  });
});

// ── Deduplication ────────────────────────────────────────────────────────────

describe('Google webhook — deduplication', () => {
  let store: InMemorySubscriptionStore;
  let webhookEventStore: InMemoryWebhookEventStore;
  let server: TestServer;

  beforeEach(() => {
    store = new InMemorySubscriptionStore();
    webhookEventStore = new InMemoryWebhookEventStore();
    server = buildServer(baseConfig, store, webhookEventStore);
  });

  it('processes the first delivery and returns received=true', async () => {
    await store.save(sampleSub({ originalTransactionId: 'tok_dedup1' }));

    const resp = await server.request(googlePushBody(2, 'tok_dedup1', { messageId: 'msg-dedup-1' }));

    expect(resp.status).toBe(200);
    expect((resp.body as { received: boolean }).received).toBe(true);
    expect((resp.body as { deduped?: boolean }).deduped).toBeUndefined();
  });

  it('returns deduped=true and skips store update on replay', async () => {
    await store.save(sampleSub({ originalTransactionId: 'tok_dedup2', status: 'active' }));

    const body = googlePushBody(3, 'tok_dedup2', { messageId: 'msg-dedup-2' }); // CANCELED

    // First delivery → status becomes canceled
    await server.request(body);
    expect((await store.getByTransactionId('tok_dedup2'))?.status).toBe(SUBSCRIPTION_STATUS.CANCELED);

    // Restore to simulate rollback
    await store.save(sampleSub({ originalTransactionId: 'tok_dedup2', status: 'active' }));

    // Replay → must be skipped, status stays active
    const replay = await server.request(body);
    expect(replay.status).toBe(200);
    expect((replay.body as { deduped: boolean }).deduped).toBe(true);
    expect((await store.getByTransactionId('tok_dedup2'))?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
  });
});

// ── Notification type → status mapping ──────────────────────────────────────

describe('Google webhook — notification type mapping', () => {
  let store: InMemorySubscriptionStore;
  let server: TestServer;

  beforeEach(() => {
    store = new InMemorySubscriptionStore();
    server = buildServer(baseConfig, store);
  });

  it('SUBSCRIPTION_CANCELED (3) → canceled', async () => {
    await store.save(sampleSub({ originalTransactionId: 'tok_cancel' }));

    await server.request(googlePushBody(3, 'tok_cancel'));

    expect((await store.getByTransactionId('tok_cancel'))?.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
  });

  it('SUBSCRIPTION_REVOKED (12) → canceled', async () => {
    await store.save(sampleSub({ originalTransactionId: 'tok_revoke' }));

    await server.request(googlePushBody(12, 'tok_revoke'));

    expect((await store.getByTransactionId('tok_revoke'))?.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
  });

  it('SUBSCRIPTION_EXPIRED (13) → expired', async () => {
    await store.save(sampleSub({ originalTransactionId: 'tok_exp' }));

    await server.request(googlePushBody(13, 'tok_exp'));

    expect((await store.getByTransactionId('tok_exp'))?.status).toBe(SUBSCRIPTION_STATUS.EXPIRED);
  });

  it('SUBSCRIPTION_IN_GRACE_PERIOD (6) → grace_period', async () => {
    await store.save(sampleSub({ originalTransactionId: 'tok_grace' }));

    await server.request(googlePushBody(6, 'tok_grace'));

    expect((await store.getByTransactionId('tok_grace'))?.status).toBe(SUBSCRIPTION_STATUS.GRACE_PERIOD);
  });

  it('SUBSCRIPTION_ON_HOLD (5) → on_hold', async () => {
    await store.save(sampleSub({ originalTransactionId: 'tok_hold' }));

    await server.request(googlePushBody(5, 'tok_hold'));

    expect((await store.getByTransactionId('tok_hold'))?.status).toBe(SUBSCRIPTION_STATUS.ON_HOLD);
  });

  it('SUBSCRIPTION_PURCHASED (4) → active', async () => {
    await store.save(sampleSub({ originalTransactionId: 'tok_buy', status: 'expired' }));

    await server.request(googlePushBody(4, 'tok_buy'));

    expect((await store.getByTransactionId('tok_buy'))?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
  });

  it('unknown notification type (SUBSCRIPTION_DEFERRED=9) falls back to active', async () => {
    // Type 9 is not handled by any isGoogle*Notification helper → else branch → ACTIVE
    await store.save(sampleSub({ originalTransactionId: 'tok_deferred', status: 'on_hold' }));

    await server.request(googlePushBody(9, 'tok_deferred'));

    expect((await store.getByTransactionId('tok_deferred'))?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
  });

  it('returns 200 even when purchaseToken is unknown (no store record, no serviceAccountKey)', async () => {
    // Without serviceAccountKey, server cannot re-fetch from Play API.
    // Should log a warning and ack 200 so Google doesn't retry forever.
    const resp = await server.request(googlePushBody(2, 'tok_unknown_no_key'));
    expect(resp.status).toBe(200);
    expect((resp.body as { received: boolean }).received).toBe(true);
  });
});
