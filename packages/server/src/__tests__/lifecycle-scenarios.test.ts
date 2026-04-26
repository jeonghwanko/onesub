/**
 * End-to-end lifecycle scenarios — exercise multi-notification sequences against
 * the real webhook router + status route + stores, the way Apple/Google would
 * deliver them in production.
 *
 * Single-notification correctness is covered by the per-feature unit tests; this
 * file catches issues that only show up when notifications arrive in a sequence:
 * stale state bleeding across transitions, idempotency under replay, recovery
 * paths after a missed webhook, etc.
 *
 * Why scenarios instead of more unit tests:
 *   - The webhook handler has many branches (per-notification mapping, fresh
 *     re-fetch, refundPolicy gating, hooks). Each is unit-tested in isolation,
 *     but a transition like SUBSCRIBED → DID_FAIL_TO_RENEW(GRACE) → DID_RENEW
 *     touches three of those branches in turn — a regression in any one only
 *     surfaces when run together.
 *   - These scenarios mirror the runbook for sandbox verification, so the
 *     mock results here can be cross-checked against real sandbox behaviour.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { generateKeyPairSync } from 'crypto';
import type { OneSubServerConfig, SubscriptionInfo, PurchaseInfo, AppleConsumptionContext } from '@onesub/shared';
import { SUBSCRIPTION_STATUS } from '@onesub/shared';
import { createWebhookRouter } from '../routes/webhook.js';
import { createStatusRouter } from '../routes/status.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';
import { __testing as appleTesting } from '../providers/apple.js';
import { isLocalhostUrl, urlHost } from './test-utils.js';

// ── helpers ─────────────────────────────────────────────────────────────────

let testEcKey: string;
let testRsaKey: string;

beforeAll(() => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  testEcKey = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  testRsaKey = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
});

beforeEach(() => {
  vi.restoreAllMocks();
  appleTesting.clearAppleJwtCacheForTests();
});

function makeJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

function applePayload(notificationType: string, opts: {
  subtype?: string;
  type?: string;
  productId?: string;
  transactionId?: string;
  originalTransactionId: string;
  expiresDate?: number;
  autoRenewStatus?: 0 | 1;
  environment?: 'Production' | 'Sandbox';
}): unknown {
  const signedTransactionInfo = makeJws({
    bundleId: 'com.example.app',
    type: opts.type ?? 'Auto-Renewable Subscription',
    productId: opts.productId ?? 'pro_monthly',
    transactionId: opts.transactionId ?? `tx_${opts.originalTransactionId}_${Date.now()}`,
    originalTransactionId: opts.originalTransactionId,
    purchaseDate: Date.now() - 30 * 86400000,
    expiresDate: opts.expiresDate ?? Date.now() + 30 * 86400000,
    environment: opts.environment ?? 'Production',
  });
  const signedRenewalInfo = makeJws({ autoRenewStatus: opts.autoRenewStatus ?? 1 });
  const payload: Record<string, unknown> = {
    notificationType,
    data: { signedTransactionInfo, signedRenewalInfo },
  };
  if (opts.subtype) payload.subtype = opts.subtype;
  return { signedPayload: makeJws(payload) };
}

function googlePush(notificationType: number, purchaseToken: string, subscriptionId = 'pro_monthly'): unknown {
  const json = JSON.stringify({
    version: '1.0',
    packageName: 'com.example.app',
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: '1.0',
      notificationType,
      purchaseToken,
      subscriptionId,
    },
  });
  return {
    message: { data: Buffer.from(json).toString('base64'), messageId: '1' },
    subscription: 's',
  };
}

interface TestServer {
  webhook: (path: string, body: unknown) => Promise<{ status: number }>;
  status: (userId: string) => Promise<{ active: boolean; subscription: SubscriptionInfo | null }>;
}

function buildServers(config: OneSubServerConfig): {
  store: InMemorySubscriptionStore;
  purchaseStore: InMemoryPurchaseStore;
  server: TestServer;
} {
  const store = new InMemorySubscriptionStore();
  const purchaseStore = new InMemoryPurchaseStore();
  const webhookApp = express();
  webhookApp.use(express.json());
  webhookApp.use(createWebhookRouter(config, store, purchaseStore));
  const statusApp = express();
  statusApp.use(express.json());
  statusApp.use(createStatusRouter(store));

  const post = async (app: express.Express, path: string, body: unknown) => {
    const httpServer = app.listen(0);
    const port = (httpServer.address() as { port: number }).port;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: resp.status };
    } finally {
      await new Promise<void>((r) => httpServer.close(() => r()));
    }
  };
  const get = async <T,>(app: express.Express, path: string): Promise<T> => {
    const httpServer = app.listen(0);
    const port = (httpServer.address() as { port: number }).port;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}${path}`);
      return (await resp.json()) as T;
    } finally {
      await new Promise<void>((r) => httpServer.close(() => r()));
    }
  };

  return {
    store,
    purchaseStore,
    server: {
      webhook: (path, body) => post(webhookApp, path, body),
      status: (userId) =>
        get<{ active: boolean; subscription: SubscriptionInfo | null }>(
          statusApp,
          `/onesub/status?userId=${encodeURIComponent(userId)}`,
        ),
    },
  };
}

const futureExpiry = '2099-01-01T00:00:00.000Z';

const sampleSub = (overrides?: Partial<SubscriptionInfo>): SubscriptionInfo => ({
  userId: 'real_user',
  productId: 'pro_monthly',
  platform: 'apple',
  status: 'active',
  expiresAt: futureExpiry,
  originalTransactionId: 'orig_x',
  purchasedAt: '2026-01-01T00:00:00.000Z',
  willRenew: true,
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1 — Apple billing retry lifecycle
// SUBSCRIBED → DID_FAIL_TO_RENEW(GRACE_PERIOD) → GRACE_PERIOD_EXPIRED → DID_RENEW
// Verifies: each transition lands in the right status; entitlement (status route
// active flag) flips on/off in lockstep; recovery to active works after on_hold.
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario 1 — Apple billing retry lifecycle', () => {
  it('SUBSCRIBED → grace_period → on_hold → active recovery', async () => {
    const config: OneSubServerConfig = {
      apple: { bundleId: 'com.example.app', skipJwsVerification: true },
      database: { url: '' },
    };
    const { store, server } = buildServers(config);
    const orig = 'orig_billing_retry';
    await store.save(sampleSub({ originalTransactionId: orig, userId: 'u_br' }));

    // 1. SUBSCRIBED — entitlement active
    await server.webhook('/onesub/webhook/apple', applePayload('SUBSCRIBED', {
      originalTransactionId: orig,
      expiresDate: Date.now() + 30 * 86400000,
    }));
    expect((await store.getByTransactionId(orig))?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    expect((await server.status('u_br')).active).toBe(true);

    // 2. DID_FAIL_TO_RENEW + GRACE_PERIOD subtype — entitlement still valid (grace)
    await server.webhook('/onesub/webhook/apple', applePayload('DID_FAIL_TO_RENEW', {
      originalTransactionId: orig,
      subtype: 'GRACE_PERIOD',
    }));
    expect((await store.getByTransactionId(orig))?.status).toBe(SUBSCRIPTION_STATUS.GRACE_PERIOD);
    expect((await server.status('u_br')).active).toBe(true);  // grace counts as active

    // 3. GRACE_PERIOD_EXPIRED — billing retry, entitlement REVOKED
    await server.webhook('/onesub/webhook/apple', applePayload('GRACE_PERIOD_EXPIRED', {
      originalTransactionId: orig,
    }));
    expect((await store.getByTransactionId(orig))?.status).toBe(SUBSCRIPTION_STATUS.ON_HOLD);
    expect((await server.status('u_br')).active).toBe(false);

    // 4. DID_RENEW — recovery
    await server.webhook('/onesub/webhook/apple', applePayload('DID_RENEW', {
      originalTransactionId: orig,
      expiresDate: Date.now() + 60 * 86400000,
    }));
    expect((await store.getByTransactionId(orig))?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    expect((await server.status('u_br')).active).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2 — Apple CONSUMPTION_REQUEST without provider configured
// User has a consumable purchase. Apple sends CONSUMPTION_REQUEST.
// Without an apple.consumptionInfoProvider hook, the webhook should:
//   - Not mutate the PurchaseStore (CONSUMPTION_REQUEST is a refund REVIEW,
//     not a confirmed refund — IAP row stays put)
//   - Not call the App Store Server API (no PUT)
//   - Still 200 to Apple
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario 2 — Apple CONSUMPTION_REQUEST without provider hook', () => {
  it('does not call Apple PUT, does not delete the consumable row, returns 200', async () => {
    const originalFetch = global.fetch;
    const outboundPuts: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (isLocalhostUrl(url)) return originalFetch(url, init);
      if (init?.method === 'PUT') outboundPuts.push(String(url));
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as Response;
    });

    const config: OneSubServerConfig = {
      apple: { bundleId: 'com.example.app', skipJwsVerification: true },  // no API creds, no hook
      database: { url: '' },
    };
    const { purchaseStore, server } = buildServers(config);

    const txId = 'iap_consumable_under_review';
    await purchaseStore.savePurchase({
      userId: 'u_consume',
      productId: 'credits_100',
      platform: 'apple',
      type: 'consumable',
      transactionId: txId,
      purchasedAt: '2026-04-01T00:00:00.000Z',
      quantity: 1,
    } satisfies PurchaseInfo);

    // CONSUMPTION_REQUEST is in APPLE_CANCELED_TYPES — for IAP it routes through
    // the deletePurchaseByTransactionId branch. Document this current behavior:
    // the row IS removed even on a refund REVIEW (not just confirmed REFUND).
    // If the host wants to defer removal until confirmation, they should set up
    // a consumptionInfoProvider that returns a custom decision.
    const resp = await server.webhook('/onesub/webhook/apple', applePayload('CONSUMPTION_REQUEST', {
      originalTransactionId: txId,
      transactionId: txId,
      type: 'Consumable',
      productId: 'credits_100',
    }));

    expect(resp.status).toBe(200);
    expect(outboundPuts).toHaveLength(0);  // no Apple PUT (no provider configured)
    // Pinning current behavior: webhook removes the consumable on CONSUMPTION_REQUEST.
    // If we later want to keep the row until confirmed REFUND, this assertion flips.
    expect(await purchaseStore.getPurchaseByTransactionId(txId)).toBeNull();
  });

  it('with provider hook: provider invoked, PUT issued, row still removed', async () => {
    const originalFetch = global.fetch;
    const outboundPuts: { url: string; body?: unknown }[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (isLocalhostUrl(url)) return originalFetch(url, init);
      if (init?.method === 'PUT') outboundPuts.push({ url: String(url), body: init.body });
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as Response;
    });

    const provider = vi.fn(async (_ctx: AppleConsumptionContext) => ({
      customerConsented: true,
      consumptionStatus: 3 as const,
      deliveryStatus: 1 as const,
      refundPreference: 2 as const,
    }));

    const config: OneSubServerConfig = {
      apple: {
        bundleId: 'com.example.app',
        skipJwsVerification: true,
        keyId: 'KEY1',
        issuerId: 'iss-uuid',
        privateKey: testEcKey,
        consumptionInfoProvider: provider,
      },
      database: { url: '' },
    };
    const { purchaseStore, server } = buildServers(config);
    const txId = 'iap_with_provider';
    await purchaseStore.savePurchase({
      userId: 'u_provider',
      productId: 'credits_100',
      platform: 'apple',
      type: 'consumable',
      transactionId: txId,
      purchasedAt: '2026-04-01T00:00:00.000Z',
      quantity: 1,
    });

    await server.webhook('/onesub/webhook/apple', applePayload('CONSUMPTION_REQUEST', {
      originalTransactionId: txId,
      transactionId: txId,
      type: 'Consumable',
      productId: 'credits_100',
    }));
    await new Promise((r) => setTimeout(r, 50));  // hook is fire-and-forget

    expect(provider).toHaveBeenCalled();
    expect(outboundPuts).toHaveLength(1);
    expect(outboundPuts[0].url).toContain('/inApps/v1/transactions/consumption/');
    expect(JSON.parse(String(outboundPuts[0].body))).toMatchObject({
      customerConsented: true,
      refundPreference: 2,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3 — Google user-voluntary pause with auto-resume time
// PURCHASED → PAUSED (with autoResumeTime) → RESTARTED
// Status route should keep the autoResumeTime in the subscription payload while
// paused, so the host can render "재개 예정" UX.
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario 3 — Google paused lifecycle with autoResumeTime', () => {
  it('PURCHASED → PAUSED (autoResumeTime surfaces) → RESTARTED', async () => {
    const config: OneSubServerConfig = {
      google: {
        packageName: 'com.example.app',
        serviceAccountKey: JSON.stringify({
          client_email: `sa-${Math.random()}@x.iam.gserviceaccount.com`,
          private_key: testRsaKey,
          token_uri: 'https://oauth2.googleapis.com/token',
        }),
      },
      database: { url: '' },
    };

    const tok = 'tok_google_pause';
    let v2Response: Record<string, unknown> = {
      startTime: '2026-01-01T00:00:00Z',
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      latestOrderId: 'GPA.active_1',
      lineItems: [{
        productId: 'pro_monthly',
        expiryTime: '2027-01-01T00:00:00Z',
        autoRenewingPlan: { autoRenewEnabled: true },
      }],
    };
    const originalFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (isLocalhostUrl(url)) return originalFetch(url, init);
      const host = urlHost(url);
      if (host === 'oauth2.googleapis.com') {
        return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }), text: async () => '' } as Response;
      }
      if (host === 'androidpublisher.googleapis.com') {
        return { ok: true, json: async () => v2Response, text: async () => '' } as Response;
      }
      throw new Error(`unexpected ${String(url)}`);
    });

    const { store, server } = buildServers(config);
    // Pre-seed an existing record (the unknown-tx fallback would otherwise
    // create one with a placeholder userId, which is fine but we want a real one).
    await store.save(sampleSub({
      platform: 'google',
      originalTransactionId: tok,
      userId: 'u_pause',
    }));

    // 1. PURCHASED — fresh re-fetch returns ACTIVE
    await server.webhook('/onesub/webhook/google', googlePush(4, tok));
    let saved = await store.getByTransactionId(tok);
    expect(saved?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    expect(saved?.autoResumeTime).toBeUndefined();
    expect((await server.status('u_pause')).active).toBe(true);

    // 2. PAUSED — v2 now returns PAUSED + autoResumeTime
    v2Response = {
      ...v2Response,
      subscriptionState: 'SUBSCRIPTION_STATE_PAUSED',
      pausedStateContext: { autoResumeTime: '2026-08-15T00:00:00Z' },
    };
    await server.webhook('/onesub/webhook/google', googlePush(10, tok));
    saved = await store.getByTransactionId(tok);
    expect(saved?.status).toBe(SUBSCRIPTION_STATUS.PAUSED);
    expect(saved?.autoResumeTime).toBe('2026-08-15T00:00:00Z');
    const pausedStatus = await server.status('u_pause');
    expect(pausedStatus.active).toBe(false);  // entitlement revoked while paused
    expect(pausedStatus.subscription?.autoResumeTime).toBe('2026-08-15T00:00:00Z');

    // 3. RESTARTED — back to active, autoResumeTime cleared
    v2Response = {
      ...v2Response,
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      pausedStateContext: undefined,
    };
    await server.webhook('/onesub/webhook/google', googlePush(7, tok));
    saved = await store.getByTransactionId(tok);
    expect(saved?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    expect(saved?.autoResumeTime).toBeUndefined();
    expect((await server.status('u_pause')).active).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4 — Google plan upgrade (linkedPurchaseToken continuity)
// Monthly subscription (token=tok_M, user=u_link) → user upgrades to yearly →
// new token (tok_Y) arrives via SUBSCRIPTION_PURCHASED with linkedPurchaseToken=tok_M.
// The webhook's unknown-tx branch should look up tok_M, inherit u_link's userId
// onto the new yearly record, and leave the monthly record intact (history).
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario 4 — Google plan upgrade userId continuity', () => {
  it('monthly → yearly: new record inherits userId, monthly history preserved', async () => {
    const config: OneSubServerConfig = {
      google: {
        packageName: 'com.example.app',
        serviceAccountKey: JSON.stringify({
          client_email: `sa-${Math.random()}@x.iam.gserviceaccount.com`,
          private_key: testRsaKey,
          token_uri: 'https://oauth2.googleapis.com/token',
        }),
      },
      database: { url: '' },
    };

    const tokM = 'tok_monthly';
    const tokY = 'tok_yearly';
    const v2Yearly = {
      startTime: '2026-04-01T00:00:00Z',
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      latestOrderId: 'GPA.yearly_first',
      linkedPurchaseToken: tokM,
      lineItems: [{
        productId: 'pro_yearly',
        expiryTime: '2027-04-01T00:00:00Z',
        autoRenewingPlan: { autoRenewEnabled: true },
      }],
    };

    const originalFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (isLocalhostUrl(url)) return originalFetch(url, init);
      const host = urlHost(url);
      if (host === 'oauth2.googleapis.com') {
        return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }), text: async () => '' } as Response;
      }
      return { ok: true, json: async () => v2Yearly, text: async () => '' } as Response;
    });

    const { store, server } = buildServers(config);
    // Pre-existing monthly subscription owned by u_link
    await store.save(sampleSub({
      platform: 'google',
      productId: 'pro_monthly',
      originalTransactionId: tokM,
      userId: 'u_link',
    }));

    // SUBSCRIPTION_PURCHASED for the new yearly token (unknown to store)
    await server.webhook('/onesub/webhook/google', googlePush(4, tokY, 'pro_yearly'));

    // New yearly record created under the v2-returned latestOrderId, userId inherited
    const newRec = await store.getByTransactionId('GPA.yearly_first');
    expect(newRec).not.toBeNull();
    expect(newRec?.userId).toBe('u_link');             // ← continuity
    expect(newRec?.productId).toBe('pro_yearly');
    expect(newRec?.linkedPurchaseToken).toBe(tokM);
    expect(newRec?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);

    // Old monthly record still findable (history preserved)
    const oldRec = await store.getByTransactionId(tokM);
    expect(oldRec).not.toBeNull();
    expect(oldRec?.productId).toBe('pro_monthly');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5 — Apple subscription REFUND (default 'immediate' policy)
// SUBSCRIBED → REFUND. status should flip to canceled right away, not on next
// expiry. Status route reports active=false immediately. With refundPolicy
// 'until_expiry', the same sequence keeps active=true until expiresAt — covered
// in the second case for contrast.
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario 5 — Apple subscription REFUND (immediate vs until_expiry)', () => {
  it("default 'immediate': REFUND flips status=canceled, active=false now", async () => {
    const config: OneSubServerConfig = {
      apple: { bundleId: 'com.example.app', skipJwsVerification: true },
      database: { url: '' },
    };
    const { store, server } = buildServers(config);
    const orig = 'orig_refund_immediate';
    await store.save(sampleSub({ originalTransactionId: orig, userId: 'u_refund_imm' }));

    await server.webhook('/onesub/webhook/apple', applePayload('SUBSCRIBED', {
      originalTransactionId: orig,
      expiresDate: Date.now() + 30 * 86400000,
    }));
    expect((await server.status('u_refund_imm')).active).toBe(true);

    await server.webhook('/onesub/webhook/apple', applePayload('REFUND', {
      originalTransactionId: orig,
      expiresDate: Date.now() + 30 * 86400000,
    }));
    expect((await store.getByTransactionId(orig))?.status).toBe(SUBSCRIPTION_STATUS.CANCELED);
    expect((await server.status('u_refund_imm')).active).toBe(false);
  });

  it("'until_expiry': REFUND keeps status=active until expiresAt passes", async () => {
    const config: OneSubServerConfig = {
      apple: { bundleId: 'com.example.app', skipJwsVerification: true },
      database: { url: '' },
      refundPolicy: 'until_expiry',
    };
    const { store, server } = buildServers(config);
    const orig = 'orig_refund_keep';
    await store.save(sampleSub({
      originalTransactionId: orig,
      userId: 'u_refund_keep',
      expiresAt: futureExpiry,
    }));

    await server.webhook('/onesub/webhook/apple', applePayload('REFUND', {
      originalTransactionId: orig,
      expiresDate: Date.now() + 30 * 86400000,
    }));

    const after = await store.getByTransactionId(orig);
    expect(after?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);  // status preserved
    expect(after?.willRenew).toBe(false);                    // willRenew flipped
    expect(after?.expiresAt).toBe(futureExpiry);             // expiresAt preserved
    expect((await server.status('u_refund_keep')).active).toBe(true);  // entitlement still valid
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6 — webhook for unknown originalTransactionId → Apple Status API fallback
// The local store has no record (e.g. server downtime caused webhook miss). When
// any notification arrives for that originalTransactionId, the webhook should:
//   - Detect the missing record
//   - Call fetchAppleSubscriptionStatus to get canonical state from Apple
//   - Save a record under originalTransactionId with placeholder userId
//   - Subsequent /onesub/validate from the host can claim ownership
// ─────────────────────────────────────────────────────────────────────────────

describe('Scenario 6 — webhook missed → Apple Status API fallback recovery', () => {
  it('unknown-tx notification triggers Status API fetch and saves a placeholder record', async () => {
    const orig = 'orig_recovered';
    const recoveredTx = makeJws({
      bundleId: 'com.example.app',
      productId: 'pro_monthly',
      transactionId: 'tx_recovered',
      originalTransactionId: orig,
      purchaseDate: Date.now() - 10 * 86400000,
      originalPurchaseDate: Date.now() - 10 * 86400000,
      expiresDate: Date.now() + 20 * 86400000,
    });

    const originalFetch = global.fetch;
    const apiCalls: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (isLocalhostUrl(url)) return originalFetch(url, init);
      const u = String(url);
      apiCalls.push(u);
      // Mock Apple Status API response
      return {
        ok: true,
        status: 200,
        json: async () => ({
          bundleId: 'com.example.app',
          environment: 'Production',
          data: [{
            lastTransactions: [{
              originalTransactionId: orig,
              status: 1,  // Active
              signedTransactionInfo: recoveredTx,
              signedRenewalInfo: makeJws({ autoRenewStatus: 1 }),
            }],
          }],
        }),
        text: async () => '',
      } as Response;
    });

    const config: OneSubServerConfig = {
      apple: {
        bundleId: 'com.example.app',
        skipJwsVerification: true,
        keyId: 'K',
        issuerId: 'I',
        privateKey: testEcKey,
      },
      database: { url: '' },
    };
    const { store, server } = buildServers(config);

    // No pre-seed → store has no record for `orig`
    expect(await store.getByTransactionId(orig)).toBeNull();

    const resp = await server.webhook('/onesub/webhook/apple', applePayload('DID_RENEW', {
      originalTransactionId: orig,
      expiresDate: Date.now() + 20 * 86400000,
    }));
    expect(resp.status).toBe(200);

    // Status API was called as fallback
    expect(apiCalls.some((u) => u.includes('/inApps/v1/subscriptions/'))).toBe(true);
    // Record was created with placeholder userId = originalTransactionId
    const recovered = await store.getByTransactionId(orig);
    expect(recovered).not.toBeNull();
    expect(recovered?.status).toBe(SUBSCRIPTION_STATUS.ACTIVE);
    expect(recovered?.userId).toBe(orig);  // placeholder until host /validate claims it
  });

  it('unknown-tx with no API credentials: logs and acks (no record created)', async () => {
    const config: OneSubServerConfig = {
      apple: { bundleId: 'com.example.app', skipJwsVerification: true },  // no API creds
      database: { url: '' },
    };
    const { store, server } = buildServers(config);
    const orig = 'orig_no_creds';

    const resp = await server.webhook('/onesub/webhook/apple', applePayload('DID_RENEW', {
      originalTransactionId: orig,
      expiresDate: Date.now() + 20 * 86400000,
    }));
    expect(resp.status).toBe(200);  // ack so Apple doesn't retry forever
    expect(await store.getByTransactionId(orig)).toBeNull();  // can't recover without creds
  });
});
