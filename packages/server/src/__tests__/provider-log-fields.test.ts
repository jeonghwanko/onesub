/**
 * What the Apple and Google providers actually put on a log line.
 *
 * These paths had **no log assertions at all** before this file, which is worth
 * stating plainly: the 49 call sites in `providers/apple.ts` and
 * `providers/google.ts` could have been migrated to `(message, fields)` — or
 * broken — and the whole suite would have stayed green either way. So this file
 * is not belt-and-braces on top of `log-format.test.ts`; it is the only thing
 * that holds the providers to the contract.
 *
 * It tests through the real provider functions rather than through
 * `formatLogArgs`, because the two failure modes that matter are call-site
 * failures a pure formatter test cannot see:
 *
 *   1. **A value left in the message.** `formatLogArgs` escapes whatever it is
 *      given; it cannot know that `bundleId` should have been a field. Only an
 *      assertion on the rendered line catches an interpolated value.
 *   2. **A field named differently in two places.** The point of moving values
 *      out of the message is that an operator can filter on `productId`. That is
 *      lost the moment one file calls it `product` — and nothing but an exact
 *      assertion notices.
 *
 * Hence exact-line assertions, not `toContain`. A substring match would pass on
 * `productId=x` *and* on a message that happened to mention it.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import type { OneSubLogger } from '@onesub/shared';
import { setLogger } from '../logger.js';
import { LOG_CONTINUATION } from '../log-format.js';
import { validateAppleConsumableReceipt, validateAppleReceipt } from '../providers/apple.js';
import { validateGoogleProductReceipt, validateGoogleReceipt } from '../providers/google.js';
import { urlHost } from './test-utils.js';

/** Collects rendered lines. The facade hands the sink exactly one string. */
function capture() {
  const lines: string[] = [];
  const logger: OneSubLogger = {
    info: (...args: unknown[]) => lines.push(args[0] as string),
    warn: (...args: unknown[]) => lines.push(args[0] as string),
    error: (...args: unknown[]) => lines.push(args[0] as string),
  };
  setLogger(logger);
  return lines;
}

afterEach(() => {
  setLogger(console);
  vi.restoreAllMocks();
});

/**
 * The invariant from `log-format.ts`, re-checked on real provider output: no byte
 * a caller supplied may begin a line. Continuation lines are ours, so they are
 * allowed — anything else starting a line means a value escaped its field.
 */
function noForgedLine(rendered: string): boolean {
  const cont = LOG_CONTINUATION.slice(1); // drop the leading \n
  return rendered
    .split('\n')
    .slice(1)
    .every((line) => line.startsWith(cont));
}

/** A hostile value that tries to close its field and open a new record. */
const FORGED = 'com.evil\n[onesub/apple] entitlement granted to mallory';

function makeJws(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

const APPLE_CONFIG = { bundleId: 'com.example.app', skipJwsVerification: true as const };

let testPrivateKey: string;

beforeAll(() => {
  // getAccessToken() signs a real assertion, so the key has to be real. 2048-bit
  // is CodeQL's minimum; generated once per suite.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  testPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
});

/** A usable Play config. The email varies because the token cache is keyed on it. */
function googleConfig(seed: string) {
  return {
    packageName: 'com.example.app',
    serviceAccountKey: JSON.stringify({
      client_email: `${seed}@test.iam.gserviceaccount.com`,
      private_key: testPrivateKey,
      token_uri: 'https://oauth2.googleapis.com/token',
    }),
  };
}

function applePayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    bundleId: 'com.example.app',
    type: 'Consumable',
    productId: 'credits_100',
    transactionId: 'txn_001',
    originalTransactionId: 'orig_001',
    purchaseDate: Date.now(),
    ...overrides,
  };
}

describe('apple: rejections carry the identifier an operator would filter on', () => {
  it('bundle ID mismatch names both sides', async () => {
    const lines = capture();

    await validateAppleConsumableReceipt(makeJws(applePayload({ bundleId: 'com.other' })), APPLE_CONFIG);

    expect(lines).toEqual([
      '[onesub/apple] Bundle ID mismatch bundleId=com.other expected=com.example.app',
    ]);
  });

  it('product ID mismatch names both sides', async () => {
    const lines = capture();

    await validateAppleConsumableReceipt(makeJws(applePayload()), APPLE_CONFIG, 'credits_500');

    expect(lines).toEqual([
      '[onesub/apple] Product ID mismatch productId=credits_100 expected=credits_500',
    ]);
  });

  // A subscription sent to the product endpoint is a client-side routing bug, and
  // the operator's first question is always "which app, which product". Logging
  // only the type answered neither: eleven of these landed over four days on a
  // multi-app host and not one could be attributed.
  it('a subscription sent to the product endpoint names the product and the app', async () => {
    const lines = capture();

    await validateAppleConsumableReceipt(
      makeJws(applePayload({ type: 'Auto-Renewable Subscription', productId: 'premium.monthly' })),
      APPLE_CONFIG,
    );

    // The type is quoted because it contains a space — that is the formatter
    // keeping the field boundary unambiguous, not an artifact.
    expect(lines).toEqual([
      '[onesub/apple] Invalid purchase type for product validation ' +
        'type="Auto-Renewable Subscription" productId=premium.monthly bundleId=com.example.app',
    ]);
  });

  // The receipt is the authority on which product it is, but a receipt that omits
  // productId must still be attributable — fall back to what the caller asked for.
  it('falls back to the requested product when the receipt omits one', async () => {
    const lines = capture();

    await validateAppleConsumableReceipt(
      makeJws(applePayload({ type: 'Auto-Renewable Subscription', productId: undefined })),
      APPLE_CONFIG,
      'premium.monthly',
    );

    expect(lines[0]).toContain('productId=premium.monthly');
  });

  it('a revoked purchase is attributable', async () => {
    // Without productId/transactionId this line said only "Purchase was
    // revoked/refunded" — true, and useless: an operator could not tell whose.
    const lines = capture();

    await validateAppleConsumableReceipt(
      makeJws(applePayload({ revocationDate: Date.now() })),
      APPLE_CONFIG,
    );

    expect(lines).toEqual([
      '[onesub/apple] Purchase was revoked/refunded productId=credits_100 transactionId=txn_001',
    ]);
  });

  it('a too-old receipt reports the window it missed and by how far', async () => {
    const purchaseDate = Date.UTC(2020, 0, 2, 3, 4, 5);
    const lines = capture();

    await validateAppleConsumableReceipt(makeJws(applePayload({ purchaseDate })), APPLE_CONFIG);

    // The threshold is a field, so `maxAgeHours=72` is filterable rather than
    // being spelled into the sentence as `(>72h)`.
    expect(lines).toEqual([
      '[onesub/apple] Consumable receipt too old productId=credits_100 maxAgeHours=72 ' +
        'purchaseDate=2020-01-02T03:04:05.000Z',
    ]);
  });

  it('a missing transactionId still names the product', async () => {
    const lines = capture();
    const payload = applePayload();
    delete payload['transactionId'];
    delete payload['originalTransactionId'];

    await validateAppleConsumableReceipt(makeJws(payload), APPLE_CONFIG);

    expect(lines).toEqual(['[onesub/apple] No transactionId in consumable transaction productId=credits_100']);
  });
});

describe('apple: attacker-supplied values cannot leave their field', () => {
  it('a forged bundleId is quoted and escaped', async () => {
    // bundleId is read out of the JWS. `peekAppleBundleId` in apps.ts reads it
    // from an *unverified* one, so treating it as hostile is not hypothetical.
    const lines = capture();

    await validateAppleReceipt(makeJws({ ...applePayload(), bundleId: FORGED, expiresDate: Date.now() }), APPLE_CONFIG);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      '[onesub/apple] Bundle ID mismatch ' +
        'bundleId="com.evil\\n[onesub/apple] entitlement granted to mallory" ' +
        'expected=com.example.app',
    );
    expect(noForgedLine(lines[0]!)).toBe(true);
  });

  it('an undecodable receipt reports a preview without becoming a second record', async () => {
    // The whole receipt is attacker-supplied here, and the preview is the one
    // field that deliberately carries raw request bytes.
    const lines = capture();

    const receipt = `${FORGED} not-a-jws`;

    await validateAppleReceipt(receipt, APPLE_CONFIG);

    expect(lines).toHaveLength(1);
    const [rendered] = lines as [string];
    expect(noForgedLine(rendered)).toBe(true);
    expect(rendered.startsWith('[onesub/apple] Failed to decode receipt as JWS receiptPreview="com.evil\\n')).toBe(true);
    // Length and part count are separate fields, not prose inside the preview.
    // Derived from the input rather than hardcoded: a literal would silently stop
    // describing the receipt if FORGED were ever edited.
    expect(rendered).toContain(` receiptLength=${receipt.length} jwsParts=${receipt.split('.').length} `);
    // Passing `err` rather than `err.message` is what keeps the stack — the
    // previous call site threw it away.
    expect(rendered).toContain(' err=');
    expect(rendered).toContain(`${LOG_CONTINUATION}at `);
  });
});

describe('google: rejections carry productId, and never the purchaseToken', () => {
  function mockPlayFetch(purchase: Record<string, unknown>) {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const host = urlHost(url);
      if (host === 'oauth2.googleapis.com') {
        return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }), text: async () => '' } as Response;
      }
      if (host === 'androidpublisher.googleapis.com') {
        return { ok: true, json: async () => purchase, text: async () => JSON.stringify(purchase) } as Response;
      }
      throw new Error(`[test] Unexpected fetch URL: ${String(url)}`);
    });
  }

  it('a misconfiguration names the product that was refused', async () => {
    const lines = capture();

    await validateGoogleProductReceipt('token_abc', 'coins_50', { packageName: 'com.example.app' });

    expect(lines).toEqual([
      '[onesub/google] No serviceAccountKey — cannot validate product receipt productId=coins_50',
    ]);
  });

  it('an uncompleted purchase reports state and orderId', async () => {
    mockPlayFetch({ purchaseState: 2, orderId: 'GPA.1234', purchaseTimeMillis: String(Date.now()) });
    const lines = capture();

    await validateGoogleProductReceipt('token_abc', 'coins_50', googleConfig('uncompleted'));

    expect(lines).toEqual([
      '[onesub/google] Purchase not completed productId=coins_50 purchaseState=2 orderId=GPA.1234',
    ]);
  });

  // The replay warning moved to routes/purchase.ts, which is the only place that
  // can tell a replay from a legitimate restore of a purchase we already have on
  // record. The provider no longer decides, so it no longer warns.
  it('does not call an already-consumed consumable a replay on its own', async () => {
    mockPlayFetch({
      purchaseState: 0,
      consumptionState: 1,
      orderId: 'GPA.1234',
      purchaseTimeMillis: String(Date.now()),
    });
    const lines = capture();

    const result = await validateGoogleProductReceipt(
      'token_abc',
      'coins_50',
      googleConfig('replay'),
      'consumable',
    );

    expect(result?.alreadyConsumed).toBe(true);
    expect(lines).toEqual([]);
  });

  it('does not log the purchaseToken, which can cancel a subscription', async () => {
    // These call sites have `purchaseToken` in scope, so "tidying values into
    // fields" could have swept it in. By webhook-google.ts's own warning a
    // purchaseToken is enough to cancel a subscription; a value that grants a
    // capability does not belong in a log line that was not carrying it before.
    const lines = capture();

    await validateGoogleProductReceipt('SECRET_CAPABILITY_TOKEN', 'coins_50', {
      packageName: 'com.example.app',
    });

    expect(lines.join('\n')).not.toContain('SECRET_CAPABILITY_TOKEN');
  });

  it('a hostile productId is quoted rather than starting a record', async () => {
    // productId comes straight off the request body.
    const lines = capture();

    await validateGoogleReceipt('token_abc', FORGED, { packageName: 'com.example.app' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      '[onesub/google] No serviceAccountKey provided — cannot call Play API ' +
        'productId="com.evil\\n[onesub/apple] entitlement granted to mallory"',
    );
    expect(noForgedLine(lines[0]!)).toBe(true);
  });

  it('renders the available lineItem products as one field, not a joined sentence', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      const host = urlHost(url);
      if (host === 'oauth2.googleapis.com') {
        return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }), text: async () => '' } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
          lineItems: [{ productId: 'monthly' }, { productId: 'yearly' }],
        }),
        text: async () => '',
      } as Response;
    });
    const lines = capture();

    await validateGoogleReceipt('token_abc', 'weekly', googleConfig('lineitems'));

    expect(lines).toEqual([
      '[onesub/google] productId not found in subscription lineItems ' +
        'productId=weekly availableProductIds="[\\"monthly\\",\\"yearly\\"]"',
    ]);
  });
});
