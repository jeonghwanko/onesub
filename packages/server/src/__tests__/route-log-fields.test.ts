/**
 * What the routes, stores and webhook handlers put on a log line.
 *
 * This is the half of the migration that delivers the point of it. `userId` does not
 * exist in the provider layer — it arrives in a request body — so "show me every
 * rejection for this user" only became answerable when these call sites moved.
 * `provider-log-fields.test.ts` covers Apple and Google; this covers the other 54.
 *
 * Driven through HTTP with supertest rather than by calling handlers, because two of
 * the values under test (`userId`, `bundleId`) are attacker-supplied through the
 * request and the escaping only matters on that path. `bundleId` in particular is
 * read out of an **unverified** JWS by `peekAppleBundleId`, which makes
 * `apps.ts`'s "No app configured" line the most attacker-reachable log site in the
 * package.
 *
 * Exact-line assertions again, for the reason given in `provider-log-fields.test.ts`:
 * a substring match cannot tell a field from a sentence that mentions the value.
 */

import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createOneSubMiddleware } from '../index.js';
import type { OneSubMiddlewareConfig } from '../index.js';
import { InMemoryPurchaseStore, InMemorySubscriptionStore } from '../store.js';
import { setLogger } from '../logger.js';
import { LOG_CONTINUATION } from '../log-format.js';

/** Collects rendered lines; the facade hands the sink exactly one string. */
function capture() {
  const lines: string[] = [];
  const push = (...args: unknown[]) => void lines.push(args[0] as string);
  setLogger({ info: push, warn: push, error: push });
  return lines;
}

afterEach(() => setLogger(console));

/** A userId that tries to close its field and open a new record. */
const FORGED_USER = 'mallory\n[onesub] entitlement granted to mallory';

function makeApp(overrides: Partial<OneSubMiddlewareConfig> = {}) {
  const store = new InMemorySubscriptionStore();
  const purchaseStore = new InMemoryPurchaseStore();
  const app = express();
  app.use(
    createOneSubMiddleware({
      database: { url: '' },
      adminSecret: 'test-admin-secret-that-is-long-enough',
      apple: { bundleId: 'com.example.app', mockMode: true },
      google: { packageName: 'com.example.app', mockMode: true },
      store,
      purchaseStore,
      ...overrides,
    }),
  );
  return { app, store, purchaseStore };
}

/** Only the first line may start with caller bytes; the rest must be ours. */
function noForgedLine(rendered: string): boolean {
  const cont = LOG_CONTINUATION.slice(1);
  return rendered
    .split('\n')
    .slice(1)
    .every((line) => line.startsWith(cont));
}

describe('validate route', () => {
  it('an account-binding mismatch names the user and the transaction', async () => {
    const { app } = makeApp();
    const lines = capture();

    const res = await request(app)
      .post('/onesub/validate')
      .send({
        platform: 'apple',
        receipt: 'MOCK_VALID#token=someone-else',
        userId: 'alice',
        productId: 'pro_monthly',
      });

    expect(res.status).toBe(409);
    expect(lines).toHaveLength(1);
    // originalTransactionId is a mock digest, so match around it rather than pinning it.
    expect(lines[0]).toMatch(
      /^\[onesub\/validate\] account binding mismatch — receipt token does not match userId originalTransactionId=mock_apple_orig_[0-9a-f]+ userId=alice$/,
    );
  });

  it('quotes a forged userId instead of letting it start a record', async () => {
    const { app } = makeApp();
    const lines = capture();

    await request(app)
      .post('/onesub/validate')
      .send({
        platform: 'apple',
        receipt: 'MOCK_VALID#token=someone-else',
        userId: FORGED_USER,
        productId: 'pro_monthly',
      });

    expect(lines).toHaveLength(1);
    const [rendered] = lines as [string];
    expect(noForgedLine(rendered)).toBe(true);
    expect(rendered).toContain(' userId="mallory\\n[onesub] entitlement granted to mallory"');
  });

  it('an unexpected store failure reports the request it was serving', async () => {
    // Before this migration the line was 'Unexpected error:' plus a stack, with
    // nothing tying it to a user, product or platform.
    const store = new InMemorySubscriptionStore();
    store.save = () => Promise.reject(new Error('store is down'));
    const { app } = makeApp({ store });
    const lines = capture();

    const res = await request(app)
      .post('/onesub/validate')
      .send({ platform: 'apple', receipt: 'MOCK_VALID', userId: 'alice', productId: 'pro_monthly' });

    expect(res.status).toBe(500);
    const [rendered] = lines as [string];
    expect(rendered.split('\n')[0]).toBe(
      '[onesub/validate] Unexpected error userId=alice productId=pro_monthly platform=apple ' +
        'err=Error err.msg="store is down"',
    );
    // The stack is still there, as continuation lines.
    expect(rendered).toContain(`${LOG_CONTINUATION}at `);
  });
});

describe('purchase route', () => {
  it('a reassignment records both users, so the move is auditable', async () => {
    const { app, purchaseStore } = makeApp();
    // Seed the transaction under a different user.
    await request(app).post('/onesub/purchase/validate').send({
      platform: 'apple',
      receipt: 'MOCK_VALID_NC',
      userId: 'alice',
      productId: 'lifetime',
      type: 'non_consumable',
    });
    const seeded = await purchaseStore.getPurchasesByUserId('alice');
    expect(seeded).toHaveLength(1);

    const lines = capture();
    await request(app).post('/onesub/purchase/validate').send({
      platform: 'apple',
      receipt: 'MOCK_VALID_NC',
      userId: 'bob',
      productId: 'lifetime',
      type: 'non_consumable',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      `[onesub/purchase] reassigned transaction to a new user transactionId=${seeded[0]!.transactionId} ` +
        'fromUserId=alice userId=bob',
    );
  });

  it('a binding mismatch names the transaction and the user', async () => {
    const { app } = makeApp();
    const lines = capture();

    const res = await request(app).post('/onesub/purchase/validate').send({
      platform: 'apple',
      receipt: 'MOCK_VALID_NC#token=someone-else',
      userId: 'alice',
      productId: 'lifetime',
      type: 'non_consumable',
    });

    expect(res.status).toBe(409);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[onesub\/purchase\] account binding mismatch — token does not match userId transactionId=\S+ userId=alice$/,
    );
  });
});

describe('status route', () => {
  it('a store failure names the user whose status was being read', async () => {
    const store = new InMemorySubscriptionStore();
    store.getByUserId = () => Promise.reject(new Error('read timeout'));
    const { app } = makeApp({ store });
    const lines = capture();

    const res = await request(app).get('/onesub/status').query({ userId: 'alice' });

    expect(res.status).toBe(500);
    expect(lines[0]!.split('\n')[0]).toBe(
      '[onesub/status] Store error userId=alice err=Error err.msg="read timeout"',
    );
  });
});

describe('app registry — the most attacker-reachable log site in the package', () => {
  it('quotes a bundleId taken from an unverified JWS', async () => {
    // peekAppleBundleId (apps.ts) decodes the receipt WITHOUT verifying it, purely
    // to pick an app. So this value is fully attacker-controlled and reaches a log
    // line before any signature check has happened.
    const jws = (payload: Record<string, unknown>) =>
      `${Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url')}.` +
      `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
    const { app } = makeApp({
      apple: { bundleId: 'com.example.app' },
      apps: [{ id: 'main', apple: { bundleId: 'com.example.app' } }],
    });
    const lines = capture();

    await request(app)
      .post('/onesub/validate')
      .send({
        platform: 'apple',
        receipt: jws({ bundleId: 'com.evil\n[onesub] admin granted premium', productId: 'p' }),
        userId: 'alice',
        productId: 'pro_monthly',
      });

    const offending = lines.filter((l) => l.startsWith('[onesub] No app configured for bundleId'));
    expect(offending).toHaveLength(1);
    expect(offending[0]).toBe(
      '[onesub] No app configured for bundleId bundleId="com.evil\\n[onesub] admin granted premium"',
    );
    expect(noForgedLine(offending[0]!)).toBe(true);
  });
});

describe('admin route', () => {
  it('a sandbox override records who it was set for and to what', async () => {
    const { app } = makeApp();
    const lines = capture();

    const res = await request(app)
      .put('/onesub/admin/test-overrides/alice')
      .set('x-admin-secret', 'test-admin-secret-that-is-long-enough')
      .send({ entitled: false });

    expect(res.status).toBe(200);
    expect(lines).toEqual(['[onesub/admin] sandbox test override set userId=alice entitled=false']);
  });
});

describe('webhook handlers', () => {
  it('an unknown purchaseToken is a named field, which is what makes redaction possible', async () => {
    // The token is logged in full — it is the lookup key an operator needs. Naming
    // it is the prerequisite for a redaction pass, not the redaction itself.
    const { app } = makeApp();
    const lines = capture();

    const notification = {
      version: '1.0',
      packageName: 'com.example.app',
      eventTimeMillis: String(Date.now()),
      subscriptionNotification: {
        version: '1.0',
        notificationType: 13, // EXPIRED
        purchaseToken: 'tok_unknown_123',
        subscriptionId: 'monthly',
      },
    };
    const res = await request(app)
      .post('/onesub/webhook/google')
      .send({
        message: {
          data: Buffer.from(JSON.stringify(notification)).toString('base64'),
          messageId: 'msg-1',
        },
        subscription: 'projects/p/subscriptions/s',
      });

    expect(res.status).toBe(200);
    const line = lines.find((l) => l.includes('Unknown purchase token'));
    expect(line).toBe(
      '[onesub/webhook/google] Unknown purchase token and no serviceAccountKey to re-fetch ' +
        'purchaseToken=tok_unknown_123',
    );
  });

  it('a store failure during Apple processing is tied to the notification', async () => {
    const store = new InMemorySubscriptionStore();
    store.getByTransactionId = () => Promise.reject(new Error('store exploded'));
    const { app } = makeApp({ store, apple: { bundleId: 'com.example.app', skipJwsVerification: true } });
    const lines = capture();

    const signed = (payload: Record<string, unknown>) =>
      `${Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url')}.` +
      `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

    await request(app)
      .post('/onesub/webhook/apple')
      .send({
        signedPayload: signed({
          notificationType: 'DID_RENEW',
          notificationUUID: 'uuid-1',
          data: {
            bundleId: 'com.example.app',
            environment: 'Sandbox',
            signedTransactionInfo: signed({
              originalTransactionId: 'orig-1',
              productId: 'monthly',
              expiresDate: Date.now() + 86_400_000,
              bundleId: 'com.example.app',
            }),
          },
        }),
      });

    const line = lines.find((l) => l.includes('Store update error'));
    expect(line?.split('\n')[0]).toBe(
      '[onesub/webhook/apple] Store update error notificationUUID=uuid-1 err=Error err.msg="store exploded"',
    );
  });
});
