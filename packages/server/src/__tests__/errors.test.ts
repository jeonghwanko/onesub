/**
 * Error-response helpers, and the guarantee that a 500 does not describe the
 * server's internals to the caller.
 *
 * `parseOrSend` replaced three hand-rolled input-validation shapes across the
 * routes. The parts worth pinning down are the ones a caller can observe: the
 * status, the `errorCode`, whether the route's response shape survives on the
 * error path, and — for the admin routes, which used to forward
 * `(err as Error).message` verbatim — that internal failure text stays server-side.
 */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { z } from 'zod';
import type { Response } from 'express';
import { ONESUB_ERROR_CODE } from '@onesub/shared';
import { parseOrSend } from '../errors.js';
import { createOneSubMiddleware } from '../index.js';
import { InMemorySubscriptionStore, InMemoryPurchaseStore } from '../store.js';
import type { SubscriptionStore } from '../store.js';

/** Minimal Response stand-in that records what a handler sent. */
function fakeRes() {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  };
  return { res: res as unknown as Response, sent };
}

const schema = z.object({ userId: z.string().min(1), count: z.coerce.number().int() });

describe('parseOrSend', () => {
  it('returns the parsed value and sends nothing on success', () => {
    const { res, sent } = fakeRes();
    const out = parseOrSend(res, schema, { userId: 'u', count: '3' });
    expect(out).toEqual({ userId: 'u', count: 3 });
    expect(sent.status).toBeUndefined();
  });

  it('sends 400 INVALID_INPUT with per-issue detail by default', () => {
    const { res, sent } = fakeRes();
    const out = parseOrSend(res, schema, { userId: '', count: 'abc' });
    expect(out).toBeUndefined();
    expect(sent.status).toBe(400);
    const body = sent.body as { errorCode: string; error: string };
    expect(body.errorCode).toBe(ONESUB_ERROR_CODE.INVALID_INPUT);
    // Detail comes from the schema's own issues rather than a fixed string.
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('sends the given message instead of the detail when asked', () => {
    const { res, sent } = fakeRes();
    const out = parseOrSend(res, schema, {}, { message: 'userId and count are required' });
    expect(out).toBeUndefined();
    const body = sent.body as { errorCode: string; error: string };
    expect(body.error).toBe('userId and count are required');
    expect(body.errorCode).toBe(ONESUB_ERROR_CODE.INVALID_INPUT);
  });

  it('merges the route shape into the error body', () => {
    const { res, sent } = fakeRes();
    parseOrSend(res, schema, {}, { extra: { valid: false, subscription: null } });
    expect(sent.body).toMatchObject({ valid: false, subscription: null });
  });

  it('lets a non-zod failure inside the schema propagate', () => {
    // A throwing refinement is a bug in the server, not bad input from the
    // caller. The old `catch {}` shape reported it as a 400; this must not.
    const exploding = z.string().transform(() => {
      throw new Error('refinement blew up');
    });
    const { res } = fakeRes();
    expect(() => parseOrSend(res, exploding, 'anything')).toThrow(/refinement blew up/);
  });
});

// ---------------------------------------------------------------------------
// 500 responses must not describe the server
// ---------------------------------------------------------------------------

const SECRET = 's3cr3t';
const AUTH = { 'x-admin-secret': SECRET };
/** Distinctive text that must never reach the client. */
const INTERNAL = 'connection to db-primary.internal:5432 refused (role "onesub_rw")';

/** A store whose reads fail the way a real outage would. */
function explodingStore(): SubscriptionStore {
  const inner = new InMemorySubscriptionStore();
  return {
    save: (s) => inner.save(s),
    getByUserId: () => Promise.reject(new Error(INTERNAL)),
    getByTransactionId: () => Promise.reject(new Error(INTERNAL)),
    getAllByUserId: () => Promise.reject(new Error(INTERNAL)),
    listAll: () => Promise.reject(new Error(INTERNAL)),
    listFiltered: () => Promise.reject(new Error(INTERNAL)),
  };
}

function buildApp() {
  const app = express();
  app.use(
    createOneSubMiddleware({
      database: { url: '' },
      apple: { bundleId: 'com.test.mock', mockMode: true },
      adminSecret: SECRET,
      // Disable the metrics cache so each request actually reaches the store.
      metricsCacheTtlSeconds: 0,
      store: explodingStore(),
      purchaseStore: new InMemoryPurchaseStore(),
    }),
  );
  return app;
}

describe('a failing store does not leak internals through admin routes', () => {
  const cases: Array<{ name: string; path: string }> = [
    { name: 'subscription list', path: '/onesub/admin/subscriptions' },
    { name: 'subscription detail', path: '/onesub/admin/subscriptions/tx-1' },
    { name: 'customer profile', path: '/onesub/admin/customers/alice' },
    { name: 'metrics active', path: '/onesub/metrics/active' },
    {
      name: 'metrics started',
      path: '/onesub/metrics/started?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z',
    },
  ];

  for (const { name, path } of cases) {
    it(`${name} → 500 with a generic message`, async () => {
      const res = await request(buildApp()).get(path).set(AUTH);

      expect(res.status).toBe(500);
      expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.STORE_ERROR);
      // The whole point: the driver's message stays in the server log.
      expect(JSON.stringify(res.body)).not.toContain('db-primary.internal');
      expect(JSON.stringify(res.body)).not.toContain('onesub_rw');
      expect(res.body.error).toBe('Internal server error');
    });
  }

  it('still reports a 401 before touching the store', async () => {
    // Ordering check: a bad secret must not produce a store error at all.
    const res = await request(buildApp()).get('/onesub/admin/subscriptions').set({
      'x-admin-secret': 'wrong',
    });
    expect(res.status).toBe(401);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.INVALID_ADMIN_SECRET);
  });
});

describe('validation errors keep each route’s response shape', () => {
  function okApp() {
    const app = express();
    app.use(
      createOneSubMiddleware({
        database: { url: '' },
        apple: { bundleId: 'com.test.mock', mockMode: true },
        store: new InMemorySubscriptionStore(),
        purchaseStore: new InMemoryPurchaseStore(),
      }),
    );
    return app;
  }

  it('POST /onesub/validate keeps valid/subscription on a 400', async () => {
    const res = await request(okApp()).post('/onesub/validate').send({ platform: 'apple' });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe(ONESUB_ERROR_CODE.INVALID_INPUT);
    expect(res.body.valid).toBe(false);
    expect(res.body.subscription).toBeNull();
  });

  it('POST /onesub/purchase/validate keeps valid/purchase on a 400', async () => {
    const res = await request(okApp()).post('/onesub/purchase/validate').send({ platform: 'apple' });
    expect(res.status).toBe(400);
    expect(res.body.valid).toBe(false);
    expect(res.body.purchase).toBeNull();
  });

  it('GET /onesub/purchase/status keeps an empty purchases array on a 400', async () => {
    const res = await request(okApp()).get('/onesub/purchase/status');
    expect(res.status).toBe(400);
    expect(res.body.purchases).toEqual([]);
  });

  it('GET /onesub/status keeps active/subscription on a 400', async () => {
    const res = await request(okApp()).get('/onesub/status');
    expect(res.status).toBe(400);
    expect(res.body.active).toBe(false);
    expect(res.body.subscription).toBeNull();
  });
});
