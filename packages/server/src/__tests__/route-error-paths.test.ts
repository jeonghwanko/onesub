/**
 * Error paths that used to escape the routes' own handling: answered as the
 * wrong status, with Express's HTML page instead of `{ error, errorCode }`, or
 * not at all.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { PurchaseInfo } from '@onesub/shared';
import { ONESUB_ERROR_CODE } from '@onesub/shared';
import { createOneSubMiddleware, createOneSubServer } from '../index.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';
import { InMemoryWebhookEventStore } from '../webhook-events.js';

function makeJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

/** A purchase store whose `savePurchase` fails the way a lost INSERT race does. */
class RacingPurchaseStore extends InMemoryPurchaseStore {
  override async savePurchase(_purchase: PurchaseInfo): Promise<void> {
    const err = new Error('TRANSACTION_BELONGS_TO_OTHER_USER') as Error & { code?: string };
    err.code = 'TRANSACTION_BELONGS_TO_OTHER_USER';
    throw err;
  }
}

class BrokenPurchaseStore extends InMemoryPurchaseStore {
  override async savePurchase(_purchase: PurchaseInfo): Promise<void> {
    throw new Error('connection refused');
  }
  override async deletePurchases(_userId: string, _productId: string): Promise<number> {
    throw new Error('connection refused');
  }
}

describe('Apple webhook', () => {
  it('acknowledges a summary notification (no `data`) instead of crashing', async () => {
    const app = express();
    app.use(createOneSubMiddleware({
      database: { url: '' },
      apple: { bundleId: 'com.example.app', skipJwsVerification: true },
      store: new InMemorySubscriptionStore(),
      purchaseStore: new InMemoryPurchaseStore(),
      webhookEventStore: new InMemoryWebhookEventStore(),
    }));

    const res = await request(app)
      .post('/onesub/webhook/apple')
      .send({
        signedPayload: makeJws({
          notificationType: 'RENEWAL_EXTENSION',
          subtype: 'SUMMARY',
          notificationUUID: 'summary-1',
          summary: { requestIdentifier: 'r1', succeededCount: 3, failedCount: 0 },
        }),
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });
});

describe('error handler', () => {
  function app() {
    const a = express();
    a.use(createOneSubMiddleware({
      database: { url: '' },
      apple: { bundleId: 'com.test.mock', mockMode: true },
      store: new InMemorySubscriptionStore(),
      purchaseStore: new InMemoryPurchaseStore(),
    }));
    a.post('/host/route', (_req, res) => { res.json({ host: true }); });
    a.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(418).json({ handledBy: 'host' });
    });
    return a;
  }

  it('answers malformed JSON on a onesub route with a structured 400', async () => {
    const res = await request(app())
      .post('/onesub/validate')
      .set('Content-Type', 'application/json')
      .send('{"platform": "apple",');
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.INVALID_INPUT);
  });

  it('matches the onesub prefix case-insensitively, as Express routing does', async () => {
    const res = await request(app())
      .post('/ONESUB/validate')
      .set('Content-Type', 'application/json')
      .send('{"platform":');
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.INVALID_INPUT);
  });

  it('keeps a body-parser 4xx (unsupported charset) instead of reporting a 500', async () => {
    const res = await request(app())
      .post('/onesub/validate')
      .set('Content-Type', 'application/json; charset=klingon')
      .send('{}');
    expect(res.status).toBe(415);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.INVALID_INPUT);
  });

  it("leaves a host route's errors to the host's own handler", async () => {
    const res = await request(app())
      .post('/host/route')
      .set('Content-Type', 'application/json')
      .send('{"oops":');
    expect(res.status).toBe(418);
    expect(res.body).toEqual({ handledBy: 'host' });
  });
});

describe('errors that escape a onesub route', () => {
  // markIfNew runs before the webhook's own try/catch, so a throw there reaches
  // the error pipeline (via the route's .catch(next)).
  const throwingEvents = {
    markIfNew: async () => { throw new Error('event store down'); },
    unmark: async () => {},
  };

  it("go to the host's error handler, so host alerting keeps working", async () => {
    const a = express();
    a.use(createOneSubMiddleware({
      database: { url: '' },
      apple: { bundleId: 'com.example.app', skipJwsVerification: true },
      store: new InMemorySubscriptionStore(),
      purchaseStore: new InMemoryPurchaseStore(),
      webhookEventStore: throwingEvents as never,
    }));
    a.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(418).json({ handledBy: 'host' });
    });
    const res = await request(a).post('/onesub/webhook/apple').send({ signedPayload: makeJws({ notificationType: 'TEST', notificationUUID: 'x' }) });
    expect(res.status).toBe(418);
  });

  it('get a JSON 500 from createOneSubServer, which has no host', async () => {
    const app = createOneSubServer({
      database: { url: '' },
      apple: { bundleId: 'com.example.app', skipJwsVerification: true },
      store: new InMemorySubscriptionStore(),
      purchaseStore: new InMemoryPurchaseStore(),
      webhookEventStore: throwingEvents as never,
    });
    const res = await request(app).post('/onesub/webhook/apple').send({ signedPayload: makeJws({ notificationType: 'TEST', notificationUUID: 'x' }) });
    expect(res.status).toBe(500);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.INTERNAL_ERROR);
  });
});

describe('unknown app', () => {
  function multiApp() {
    const a = express();
    a.use(createOneSubMiddleware({
      database: { url: '' },
      apps: [
        { id: 'one', apple: { bundleId: 'com.one', skipJwsVerification: true }, google: { packageName: 'com.one', mockMode: true } },
        { id: 'two', apple: { bundleId: 'com.two', skipJwsVerification: true }, google: { packageName: 'com.two', mockMode: true } },
      ],
      defaultAppId: 'one',
      store: new InMemorySubscriptionStore(),
      purchaseStore: new InMemoryPurchaseStore(),
    }));
    return a;
  }

  it('answers an appId the server does not host with CONFIG_MISSING (500), never another app', async () => {
    // Not a 4xx on purpose: the Unity client reads a 4xx as a verdict on the
    // receipt (clears cached entitlement, blacklists the order). The server has
    // not judged the receipt; it does not know the app.
    for (const route of ['/onesub/validate', '/onesub/purchase/validate']) {
      const res = await request(multiApp()).post(route).send({
        platform: 'google',
        receipt: 'MOCK_VALID_token',
        userId: 'u1',
        productId: 'pro',
        type: 'consumable',
        appId: 'nope',
      });
      expect(res.status, route).toBe(500);
      expect(res.body.errorCode, route).toBe(ONESUB_ERROR_CODE.GOOGLE_CONFIG_MISSING);
    }
  });

  it('answers an Apple receipt from an app it does not host with APPLE_CONFIG_MISSING (500)', async () => {
    const receipt = makeJws({
      bundleId: 'com.elsewhere',
      productId: 'pro',
      originalTransactionId: 'o1',
      transactionId: 't1',
      expiresDate: Date.now() + 86400000,
    });
    const res = await request(multiApp()).post('/onesub/validate').send({
      platform: 'apple',
      receipt,
      userId: 'u1',
      productId: 'pro',
    });
    expect(res.status).toBe(500);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.APPLE_CONFIG_MISSING);
  });
});

describe('purchase ownership race', () => {
  it('answers a lost claim race with 409, not a 500', async () => {
    const app = express();
    app.use(createOneSubMiddleware({
      database: { url: '' },
      google: { packageName: 'com.test.mock', mockMode: true },
      store: new InMemorySubscriptionStore(),
      purchaseStore: new RacingPurchaseStore(),
    }));
    const res = await request(app).post('/onesub/purchase/validate').send({
      platform: 'google',
      receipt: 'MOCK_VALID_race',
      userId: 'u1',
      productId: 'coins',
      type: 'consumable',
    });
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.TRANSACTION_BELONGS_TO_OTHER_USER);
  });
});

describe('admin routes', () => {
  function adminApp(purchaseStore: InMemoryPurchaseStore) {
    const app = express();
    app.use(createOneSubMiddleware({
      database: { url: '' },
      adminSecret: 'admin-secret-long-enough-to-pass',
      store: new InMemorySubscriptionStore(),
      purchaseStore,
    }));
    return app;
  }

  it('reports a store failure on grant and reset as STORE_ERROR', async () => {
    const app = adminApp(new BrokenPurchaseStore());
    const grant = await request(app)
      .post('/onesub/purchase/admin/grant')
      .set('x-admin-secret', 'admin-secret-long-enough-to-pass')
      .send({ userId: 'u1', productId: 'p1', platform: 'apple' });
    expect(grant.status).toBe(500);
    expect(grant.body.errorCode).toBe(ONESUB_ERROR_CODE.STORE_ERROR);

    const reset = await request(app)
      .delete('/onesub/purchase/admin/u1/p1')
      .set('x-admin-secret', 'admin-secret-long-enough-to-pass');
    expect(reset.status).toBe(500);
    expect(reset.body.errorCode).toBe(ONESUB_ERROR_CODE.STORE_ERROR);
  });

  it('answers a grant for a transactionId owned by another user with 409', async () => {
    const store = new InMemoryPurchaseStore();
    await store.savePurchase({
      transactionId: 'tx_owned',
      userId: 'someone_else',
      productId: 'p1',
      platform: 'apple',
      type: 'non_consumable',
      quantity: 1,
      purchasedAt: new Date().toISOString(),
    });
    const res = await request(adminApp(store))
      .post('/onesub/purchase/admin/grant')
      .set('x-admin-secret', 'admin-secret-long-enough-to-pass')
      .send({ userId: 'u1', productId: 'p1', platform: 'apple', transactionId: 'tx_owned' });
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.TRANSACTION_BELONGS_TO_OTHER_USER);
  });
});

describe('non-consumable already owned under another transactionId', () => {
  const secret = 'admin-secret-long-enough-to-pass';
  const owned: PurchaseInfo = {
    transactionId: 'tx_first',
    userId: 'u1',
    productId: 'lifetime',
    platform: 'google',
    type: 'non_consumable',
    quantity: 1,
    purchasedAt: new Date().toISOString(),
  };

  /** Hides `owned` from the route's up-front check, as a concurrent write would. */
  class LateOwnerStore extends InMemoryPurchaseStore {
    reveal = false;
    override async getPurchasesForProduct(userId: string, productId: string) {
      return this.reveal ? super.getPurchasesForProduct(userId, productId) : [];
    }
    override async savePurchase(p: PurchaseInfo) {
      this.reveal = true;
      return super.savePurchase(p);
    }
  }

  it('purchase/validate answers a lost race with the recorded copy, as restored', async () => {
    const store = new LateOwnerStore();
    await InMemoryPurchaseStore.prototype.savePurchase.call(store, owned);
    const app = express();
    app.use(createOneSubMiddleware({
      database: { url: '' },
      google: { packageName: 'com.test.mock', mockMode: true },
      store: new InMemorySubscriptionStore(),
      purchaseStore: store,
    }));
    const res = await request(app).post('/onesub/purchase/validate').send({
      platform: 'google',
      receipt: 'MOCK_VALID_second_copy',
      userId: 'u1',
      productId: 'lifetime',
      type: 'non_consumable',
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('restored');
    expect(res.body.purchase.transactionId).toBe('tx_first');
  });

  it('admin grant and transfer answer 409 NON_CONSUMABLE_ALREADY_OWNED', async () => {
    const store = new InMemoryPurchaseStore();
    await store.savePurchase(owned);
    await store.savePurchase({ ...owned, transactionId: 'tx_other', userId: 'u2' });
    const app = express();
    app.use(createOneSubMiddleware({
      database: { url: '' },
      adminSecret: secret,
      store: new InMemorySubscriptionStore(),
      purchaseStore: store,
    }));

    const grant = await request(app)
      .post('/onesub/purchase/admin/grant')
      .set('x-admin-secret', secret)
      .send({ userId: 'u1', productId: 'lifetime', platform: 'google' });
    expect(grant.status).toBe(409);
    expect(grant.body.errorCode).toBe(ONESUB_ERROR_CODE.NON_CONSUMABLE_ALREADY_OWNED);

    const transfer = await request(app)
      .post('/onesub/purchase/admin/transfer')
      .set('x-admin-secret', secret)
      .send({ transactionId: 'tx_other', newUserId: 'u1' });
    expect(transfer.status).toBe(409);
    expect(transfer.body.errorCode).toBe(ONESUB_ERROR_CODE.NON_CONSUMABLE_ALREADY_OWNED);
    expect((await store.getPurchaseByTransactionId('tx_other'))?.userId).toBe('u2');
  });
});

describe('webhook request bodies of the wrong shape', () => {
  function app() {
    const a = express();
    a.use(createOneSubMiddleware({
      database: { url: '' },
      apple: { bundleId: 'com.example.app', skipJwsVerification: true },
      google: { packageName: 'com.example.app', allowUnauthenticatedWebhook: true },
      store: new InMemorySubscriptionStore(),
      purchaseStore: new InMemoryPurchaseStore(),
    }));
    return a;
  }

  it('answers a non-JSON body with 400, not a crash', async () => {
    const apple = await request(app()).post('/onesub/webhook/apple').set('Content-Type', 'text/plain').send('hello');
    expect(apple.status).toBe(400);
    expect(apple.body.errorCode).toBe(ONESUB_ERROR_CODE.MISSING_SIGNED_PAYLOAD);
    const google = await request(app()).post('/onesub/webhook/google').set('Content-Type', 'text/plain').send('hello');
    expect(google.status).toBe(400);
    expect(google.body.errorCode).toBe(ONESUB_ERROR_CODE.MISSING_MESSAGE_DATA);
  });

  it('answers a non-string payload field exactly as 0.27 did', async () => {
    // Apple: not a JWS → INVALID_SIGNED_PAYLOAD. Google: acknowledged, so
    // Pub/Sub does not redeliver a malformed message for days.
    const apple = await request(app()).post('/onesub/webhook/apple').send({ signedPayload: { nested: true } });
    expect(apple.status).toBe(400);
    expect(apple.body.errorCode).toBe(ONESUB_ERROR_CODE.INVALID_SIGNED_PAYLOAD);
    const google = await request(app()).post('/onesub/webhook/google').send({ message: { data: 42 } });
    expect(google.status).toBe(200);
  });
});

/** Database-like read latency, so two concurrent requests both read before either writes. */
class SlowReadPurchaseStore extends InMemoryPurchaseStore {
  override async getPurchaseByTransactionId(txId: string) {
    const snapshot = await super.getPurchaseByTransactionId(txId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return snapshot;
  }
}

describe('concurrent duplicate purchase validation', () => {
  it('grants a consumable once: the second of two concurrent identical requests is "restored"', async () => {
    const app = express();
    app.use(createOneSubMiddleware({
      database: { url: '' },
      google: { packageName: 'com.test.mock', mockMode: true },
      store: new InMemorySubscriptionStore(),
      purchaseStore: new SlowReadPurchaseStore(),
    }));
    const body = { platform: 'google', receipt: 'MOCK_VALID_coins_race', userId: 'u1', productId: 'coins', type: 'consumable' };
    const [a, b] = await Promise.all([
      request(app).post('/onesub/purchase/validate').send(body),
      request(app).post('/onesub/purchase/validate').send(body),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.action, b.body.action].sort()).toEqual(['new', 'restored']);
  });
});

