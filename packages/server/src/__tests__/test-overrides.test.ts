/**
 * Sandbox-only entitlement overrides.
 *
 * Apple cannot cancel a sandbox subscription bought with a real Apple Account
 * through TestFlight, so a tester who subscribes once stays entitled and can
 * never re-run the purchase flow. That is not a hypothetical: it hid a paywall
 * entry point from App Review (PenguinRun 2.0.6, Guideline 2.1(b)) because the
 * reviewer had subscribed in an earlier round.
 *
 * The guarantee under test is the safety one — an override must be incapable of
 * touching a paying customer. It is honoured only when the receipt just
 * validated came from Sandbox.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { OneSubServerConfig, ValidateReceiptResponse } from '@onesub/shared';
import { createOneSubMiddleware, InMemorySubscriptionStore, InMemoryPurchaseStore } from '../index.js';
import { clearAllTestOverrides } from '../test-overrides.js';

const ADMIN_SECRET = 'test-admin-secret';
const USER = 'firebase-uid-1';

function makeJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

/** An active auto-renewable subscription transaction, Sandbox or Production. */
function receipt(environment: 'Sandbox' | 'Production'): string {
  const now = Date.now();
  return makeJws({
    bundleId: 'com.example.app',
    productId: 'vip_monthly',
    transactionId: 'tx-1',
    originalTransactionId: 'orig-1',
    purchaseDate: now - 60_000,
    expiresDate: now + 30 * 24 * 60 * 60 * 1000,
    type: 'Auto-Renewable Subscription',
    environment,
  });
}

function buildApp() {
  const config: OneSubServerConfig = {
    apple: { bundleId: 'com.example.app', skipJwsVerification: true },
    database: { url: '' },
    adminSecret: ADMIN_SECRET,
  };
  const app = express();
  app.use(createOneSubMiddleware({
    ...config,
    store: new InMemorySubscriptionStore(),
    purchaseStore: new InMemoryPurchaseStore(),
  }));
  return app;
}

async function withServer<T>(app: express.Express, fn: (base: string) => Promise<T>): Promise<T> {
  const httpServer = app.listen(0);
  const port = (httpServer.address() as { port: number }).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => httpServer.close(() => r()));
  }
}

async function validate(base: string, environment: 'Sandbox' | 'Production') {
  const resp = await fetch(`${base}/onesub/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform: 'apple',
      receipt: receipt(environment),
      userId: USER,
      productId: 'vip_monthly',
    }),
  });
  return { status: resp.status, body: (await resp.json()) as ValidateReceiptResponse };
}

async function setOverride(base: string, entitled: boolean, secret = ADMIN_SECRET) {
  return fetch(`${base}/onesub/admin/test-overrides/${USER}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
    body: JSON.stringify({ entitled }),
  });
}

beforeEach(() => clearAllTestOverrides());
afterEach(() => clearAllTestOverrides());

describe('sandbox test overrides', () => {
  it('without an override, a sandbox subscription validates as active', async () => {
    await withServer(buildApp(), async (base) => {
      const { body } = await validate(base, 'Sandbox');
      expect(body.valid).toBe(true);
      expect(body.subscription?.status).toBe('active');
    });
  });

  it('forces not-entitled for a sandbox receipt once set', async () => {
    await withServer(buildApp(), async (base) => {
      const put = await setOverride(base, false);
      expect(put.status).toBe(200);

      const { body } = await validate(base, 'Sandbox');
      expect(body.valid).toBe(true);
      expect(body.subscription?.status).toBe('expired');
      expect(body.subscription?.willRenew).toBe(false);
    });
  });

  // The whole safety argument. A production receipt must be untouched even when
  // an override exists for that same userId.
  it('never affects a production receipt', async () => {
    await withServer(buildApp(), async (base) => {
      await setOverride(base, false);
      const { body } = await validate(base, 'Production');
      expect(body.subscription?.status).toBe('active');
    });
  });

  it('stops applying once cleared', async () => {
    await withServer(buildApp(), async (base) => {
      await setOverride(base, false);
      const del = await fetch(`${base}/onesub/admin/test-overrides/${USER}`, {
        method: 'DELETE',
        headers: { 'x-admin-secret': ADMIN_SECRET },
      });
      expect(del.status).toBe(200);

      const { body } = await validate(base, 'Sandbox');
      expect(body.subscription?.status).toBe('active');
    });
  });

  it('rejects a wrong admin secret', async () => {
    await withServer(buildApp(), async (base) => {
      const resp = await setOverride(base, false, 'wrong');
      expect(resp.status).toBe(401);
    });
  });

  it('never persists the transient sandbox flag', async () => {
    await withServer(buildApp(), async (base) => {
      const { body } = await validate(base, 'Sandbox');
      expect(body.subscription).not.toHaveProperty('sandbox');
    });
  });
});
