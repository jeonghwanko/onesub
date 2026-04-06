/**
 * Google Play Developer API v3 — subscription product management.
 * https://developers.google.com/android-publisher/api-ref/rest/v3/monetization.subscriptions
 *
 * Authentication: OAuth2 service account JWT assertion flow.
 * Uses native Node.js `crypto` — no external dependencies.
 */

import { createSign } from 'crypto';

const ANDROID_PUBLISHER_BASE =
  'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GooglePlayConfig {
  packageName: string;
  /** JSON string of the service account key file */
  serviceAccountKey: string;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface GoogleSubscriptionResource {
  productId?: string;
  listings?: Array<{ languageCode: string; title: string; benefits?: string[] }>;
  basePlans?: Array<{
    basePlanId: string;
    state?: string;
    autoRenewingBasePlanType?: {
      billingPeriodDuration: string;
      prorationMode?: string;
      resubscribeState?: string;
    };
    regionalConfigs?: Array<{
      regionCode: string;
      price?: { currencyCode: string; units: string; nanos: number };
      newSubscriberAvailability?: boolean;
    }>;
  }>;
}

interface GoogleSubscriptionListResponse {
  subscriptions?: GoogleSubscriptionResource[];
  nextPageToken?: string;
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/**
 * Module-level token cache per service-account key string.
 */
let tokenCache: { token: string; expiresAt: number; keyHash: string } | null = null;
let inflightPromise: Promise<string> | null = null;

async function getCachedAccessToken(serviceAccountKey: string): Promise<string> {
  const now = Date.now();
  const keyHash = serviceAccountKey.slice(0, 40); // cheap identity check

  if (
    tokenCache &&
    tokenCache.keyHash === keyHash &&
    tokenCache.expiresAt - now > 60_000
  ) {
    return tokenCache.token;
  }

  if (!inflightPromise) {
    inflightPromise = fetchAccessToken(serviceAccountKey)
      .then((token) => {
        tokenCache = { token, expiresAt: Date.now() + 3_600_000, keyHash };
        return token;
      })
      .finally(() => {
        inflightPromise = null;
      });
  }

  return inflightPromise;
}

async function fetchAccessToken(serviceAccountKey: string): Promise<string> {
  let key: ServiceAccountKey;
  try {
    key = JSON.parse(serviceAccountKey) as ServiceAccountKey;
  } catch {
    throw new Error('[google-play] Invalid serviceAccountKey JSON');
  }

  const tokenUri = key.token_uri ?? 'https://oauth2.googleapis.com/token';
  const scope = 'https://www.googleapis.com/auth/androidpublisher';
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: key.client_email,
      scope,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  ).toString('base64url');

  const signingInput = `${header}.${payload}`;
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(key.private_key, 'base64url');

  const assertion = `${signingInput}.${signature}`;

  const resp = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  const data = (await resp.json()) as TokenResponse;

  if (!resp.ok || !data.access_token) {
    const detail = data.error_description ?? data.error ?? `HTTP ${resp.status}`;
    throw new Error(`[google-play] Token request failed: ${detail}`);
  }

  return data.access_token;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function playRequest<T>(
  accessToken: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<T> {
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let json: T;
  try {
    json = JSON.parse(text) as T;
  } catch {
    throw new Error(`Google Play API ${resp.status}: non-JSON response — ${text.slice(0, 200)}`);
  }

  if (!resp.ok) {
    const errBody = json as { error?: { message?: string; status?: string } };
    const detail = errBody.error?.message ?? `HTTP ${resp.status}`;
    throw new Error(`Google Play API error — ${detail}`);
  }

  return json;
}

// ---------------------------------------------------------------------------
// Price conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert a price value (in the smallest currency unit, e.g. 499 for $4.99)
 * into Google Play's { units, nanos } format.
 *
 * Google represents prices as: units (integer dollars/major) + nanos (fractional × 10^9).
 * e.g. $4.99 → units="4", nanos=990000000
 */
function toGooglePrice(
  priceSmallestUnit: number,
  currency: string,
): { currencyCode: string; units: string; nanos: number } {
  // Most currencies use 2 decimal places; KRW/JPY/etc. use 0.
  // We treat the input as "smallest unit" (cents for USD, won for KRW).
  const zeroCurrencies = new Set([
    'KRW', 'JPY', 'VND', 'IDR', 'HUF', 'CLP', 'PYG', 'ISK',
    'TWD', 'DJF', 'GNF', 'KMF', 'MGA', 'RWF', 'UGX', 'XAF', 'XOF',
  ]);

  if (zeroCurrencies.has(currency.toUpperCase())) {
    // No sub-unit — the price IS in major units
    return { currencyCode: currency, units: String(priceSmallestUnit), nanos: 0 };
  }

  // 2-decimal currencies: input is cents (e.g. 499 → $4.99)
  const major = Math.floor(priceSmallestUnit / 100);
  const minor = priceSmallestUnit % 100;
  return {
    currencyCode: currency,
    units: String(major),
    nanos: minor * 10_000_000, // cents → nanos (1 cent = 10^7 nanos)
  };
}

/**
 * Map a period string from the tool layer to an ISO 8601 duration.
 */
function toBillingPeriod(period: string): string {
  if (period === 'yearly' || period === 'P1Y') return 'P1Y';
  if (period === 'P1M') return 'P1M';
  return 'P1M'; // default monthly
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Create a subscription product (with one base plan) on Google Play.
 *
 * The tool layer calls this with: { productId, name, price, currency, period,
 * packageName, serviceAccountKey }.
 */
export async function createGoogleSubscription(opts: {
  productId: string;
  name: string;
  price: number;
  currency: string;
  period: string;
  packageName: string;
  serviceAccountKey: string;
}): Promise<{ success: boolean; productId?: string; error?: string }> {
  try {
    const accessToken = await getCachedAccessToken(opts.serviceAccountKey);
    const pkg = encodeURIComponent(opts.packageName);
    const billingPeriod = toBillingPeriod(opts.period);
    const basePlanId = opts.period === 'yearly' || opts.period === 'P1Y' ? 'yearly' : 'monthly';
    const regionCode = opts.currency.toUpperCase() === 'KRW' ? 'KR' : 'US';

    const subscriptionBody: GoogleSubscriptionResource = {
      productId: opts.productId,
      listings: [
        {
          languageCode: 'en-US',
          title: opts.name,
          benefits: [],
        },
      ],
      basePlans: [
        {
          basePlanId,
          autoRenewingBasePlanType: {
            billingPeriodDuration: billingPeriod,
            prorationMode: 'CHARGE_ON_NEXT_BILLING_DATE',
            resubscribeState: 'RESUBSCRIBE_STATE_ACTIVE',
          },
          regionalConfigs: [
            {
              regionCode,
              price: toGooglePrice(opts.price, opts.currency),
              newSubscriberAvailability: true,
            },
          ],
          state: 'ACTIVE',
        },
      ],
    };

    // Step 1 — create the subscription
    await playRequest<GoogleSubscriptionResource>(
      accessToken,
      'POST',
      `${ANDROID_PUBLISHER_BASE}/${pkg}/subscriptions`,
      subscriptionBody,
    );

    // Step 2 — activate the base plan
    // The base plan is created in ACTIVE state in the body above, but the API
    // may require an explicit activate call depending on the app's status.
    try {
      await playRequest<Record<string, unknown>>(
        accessToken,
        'POST',
        `${ANDROID_PUBLISHER_BASE}/${pkg}/subscriptions/${encodeURIComponent(opts.productId)}/basePlans/${encodeURIComponent(basePlanId)}:activate`,
        {},
      );
    } catch {
      // Activation failure is non-fatal if the plan was already activated via the body
    }

    return { success: true, productId: opts.productId };
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * List subscription products for an app on Google Play.
 *
 * The tool layer calls this with: { packageName, serviceAccountKey }.
 */
export async function listGoogleProducts(opts: {
  packageName: string;
  serviceAccountKey: string;
}): Promise<
  Array<{
    productId: string;
    name?: string;
    status?: string;
    type?: string;
    price?: number;
    currency?: string;
  }>
> {
  const accessToken = await getCachedAccessToken(opts.serviceAccountKey);
  const pkg = encodeURIComponent(opts.packageName);

  const resp = await playRequest<GoogleSubscriptionListResponse>(
    accessToken,
    'GET',
    `${ANDROID_PUBLISHER_BASE}/${pkg}/subscriptions`,
  );

  const products: Array<{
    productId: string;
    name?: string;
    status?: string;
    type?: string;
    price?: number;
    currency?: string;
  }> = [];

  for (const sub of resp.subscriptions ?? []) {
    if (!sub.productId) continue;

    // Derive a human-readable name from the first English listing
    const listing =
      sub.listings?.find((l) => l.languageCode === 'en-US') ?? sub.listings?.[0];

    // Derive status from the first base plan
    const basePlan = sub.basePlans?.[0];
    const status = basePlan?.state ?? 'UNKNOWN';

    // Derive price from the first regional config of the first base plan
    const regionalConfig = basePlan?.regionalConfigs?.[0];
    let price: number | undefined;
    let currency: string | undefined;
    if (regionalConfig?.price) {
      const p = regionalConfig.price;
      currency = p.currencyCode;
      price = parseInt(p.units, 10) * 100 + Math.round(p.nanos / 10_000_000);
    }

    products.push({
      productId: sub.productId,
      name: listing?.title,
      status,
      type: 'SUBSCRIPTION',
      price,
      currency,
    });
  }

  return products;
}
