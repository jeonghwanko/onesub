/**
 * Google Play Developer API v3 — IAP product management.
 * https://developers.google.com/android-publisher/api-ref/rest/v3
 *
 * Covers: subscriptions, consumables, non-consumables — create / update / delete / list.
 * Authentication: OAuth2 service account JWT assertion (native Node.js crypto).
 */

import { createSign } from 'crypto';

const ANDROID_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

// ── Public types ──────────────────────────────────────────────────────────────

export interface GoogleCredentials {
  packageName: string;
  /** JSON string of the service account key file */
  serviceAccountKey: string;
}

export interface RegionPrice {
  /** ISO 4217 currency code */
  currency: string;
  /** Price in the smallest unit (cents for USD, whole units for KRW/JPY, …) */
  price: number;
}

export type GoogleProductType = 'subscription' | 'consumable' | 'non_consumable';

export interface CreateSubscriptionResult {
  success: boolean;
  productId?: string;
  error?: string;
}

export interface CreateOneTimePurchaseResult {
  success: boolean;
  productId?: string;
  error?: string;
}

export interface UpdateProductResult {
  success: boolean;
  updated: string[];
  error?: string;
}

export interface DeleteProductResult {
  success: boolean;
  error?: string;
}

export interface GoogleProductRecord {
  productId: string;
  name?: string;
  status?: string;
  type?: 'subscription' | 'consumable' | 'non_consumable';
  price?: number;
  currency?: string;
}

// ── Internal types ────────────────────────────────────────────────────────────

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

interface InAppProductResource {
  packageName?: string;
  sku?: string;
  status?: string;
  purchaseType?: string;
  listings?: Record<string, { title: string; description?: string }>;
  prices?: Record<string, { currency: string; priceMicros: string }>;
}

interface InAppProductListResponse {
  inappproduct?: InAppProductResource[];
  kind?: string;
}

// ── Token cache ───────────────────────────────────────────────────────────────

let tokenCache: { token: string; expiresAt: number; keyHash: string } | null = null;
let inflightPromise: Promise<string> | null = null;

async function getCachedToken(serviceAccountKey: string): Promise<string> {
  const now = Date.now();
  const keyHash = serviceAccountKey.slice(0, 40);
  if (tokenCache && tokenCache.keyHash === keyHash && tokenCache.expiresAt - now > 60_000) {
    return tokenCache.token;
  }
  if (!inflightPromise) {
    inflightPromise = fetchAccessToken(serviceAccountKey)
      .then((token) => { tokenCache = { token, expiresAt: now + 3_600_000, keyHash }; return token; })
      .finally(() => { inflightPromise = null; });
  }
  return inflightPromise;
}

async function fetchAccessToken(serviceAccountKey: string): Promise<string> {
  let key: ServiceAccountKey;
  try { key = JSON.parse(serviceAccountKey) as ServiceAccountKey; }
  catch { throw new Error('[google-play] Invalid serviceAccountKey JSON'); }
  const tokenUri = key.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: tokenUri, iat: now, exp: now + 3600,
  })).toString('base64url');
  const input = `${header}.${payload}`;
  const sign = createSign('RSA-SHA256');
  sign.update(input);
  const sig = sign.sign(key.private_key, 'base64url');
  const resp = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${input}.${sig}` }),
  });
  const data = (await resp.json()) as TokenResponse;
  if (!resp.ok || !data.access_token) {
    throw new Error(`[google-play] Token request failed: ${data.error_description ?? data.error ?? `HTTP ${resp.status}`}`);
  }
  return data.access_token;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function playRequest<T>(token: string, method: string, url: string, body?: unknown): Promise<T> {
  const resp = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json: T;
  try { json = JSON.parse(text) as T; }
  catch { throw new Error(`Google Play API ${resp.status}: non-JSON — ${text.slice(0, 200)}`); }
  if (!resp.ok) {
    const detail = (json as { error?: { message?: string } }).error?.message ?? `HTTP ${resp.status}`;
    throw new Error(`Google Play API error — ${detail}`);
  }
  return json;
}

// ── Price helpers ─────────────────────────────────────────────────────────────

const ZERO_DECIMAL_CURRENCIES = new Set([
  'KRW', 'JPY', 'VND', 'IDR', 'HUF', 'CLP', 'PYG', 'ISK',
  'TWD', 'DJF', 'GNF', 'KMF', 'MGA', 'RWF', 'UGX', 'XAF', 'XOF',
]);

/** Google Play subscriptions API: { units, nanos } */
function toGooglePrice(price: number, currency: string): { currencyCode: string; units: string; nanos: number } {
  if (ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase())) {
    return { currencyCode: currency, units: String(price), nanos: 0 };
  }
  return { currencyCode: currency, units: String(Math.floor(price / 100)), nanos: (price % 100) * 10_000_000 };
}

/** Google Play inappproducts API: priceMicros */
function toGooglePriceMicros(price: number, currency: string): string {
  if (ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase())) {
    return String(price * 1_000_000);
  }
  // price is in cents; priceMicros = cents * 10_000
  return String(price * 10_000);
}

function currencyToRegionCode(currency: string): string {
  const map: Record<string, string> = {
    USD: 'US', KRW: 'KR', EUR: 'DE', JPY: 'JP',
    GBP: 'GB', AUD: 'AU', CAD: 'CA', CNY: 'CN', SGD: 'SG',
  };
  return map[currency.toUpperCase()] ?? 'US';
}

function toBillingPeriod(period: string): string {
  return period === 'yearly' || period === 'P1Y' ? 'P1Y' : 'P1M';
}

// ── Exported CRUD functions ───────────────────────────────────────────────────

/**
 * Create an auto-renewable subscription on Google Play.
 */
export async function createSubscription(opts: {
  productId: string;
  name: string;
  price: number;
  currency: string;
  period: 'monthly' | 'yearly';
  extraRegions?: RegionPrice[];
  packageName: string;
  serviceAccountKey: string;
}): Promise<CreateSubscriptionResult> {
  try {
    const token = await getCachedToken(opts.serviceAccountKey);
    const pkg = encodeURIComponent(opts.packageName);
    const billingPeriod = toBillingPeriod(opts.period);
    const basePlanId = opts.period === 'yearly' ? 'yearly' : 'monthly';

    const primaryRegion = {
      regionCode: currencyToRegionCode(opts.currency),
      price: toGooglePrice(opts.price, opts.currency),
      newSubscriberAvailability: true,
    };

    const extraRegionalConfigs = (opts.extraRegions ?? []).map((r) => ({
      regionCode: currencyToRegionCode(r.currency),
      price: toGooglePrice(r.price, r.currency),
      newSubscriberAvailability: true,
    }));

    const body: GoogleSubscriptionResource = {
      productId: opts.productId,
      listings: [{ languageCode: 'en-US', title: opts.name, benefits: [] }],
      basePlans: [{
        basePlanId,
        autoRenewingBasePlanType: {
          billingPeriodDuration: billingPeriod,
          prorationMode: 'CHARGE_ON_NEXT_BILLING_DATE',
          resubscribeState: 'RESUBSCRIBE_STATE_ACTIVE',
        },
        regionalConfigs: [primaryRegion, ...extraRegionalConfigs],
        state: 'ACTIVE',
      }],
    };

    await playRequest<GoogleSubscriptionResource>(token, 'POST', `${ANDROID_BASE}/${pkg}/subscriptions`, body);

    try {
      await playRequest<Record<string, unknown>>(
        token, 'POST',
        `${ANDROID_BASE}/${pkg}/subscriptions/${encodeURIComponent(opts.productId)}/basePlans/${basePlanId}:activate`,
        {},
      );
    } catch { /* activation is non-fatal if already active via body */ }

    return { success: true, productId: opts.productId };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Create a consumable or non-consumable in-app product on Google Play.
 *
 * Note: Google Play treats all one-time products as `managedUser` at the API level.
 * Consumable vs non-consumable is an app-side distinction (consumePurchase vs acknowledgePurchase).
 */
export async function createOneTimePurchase(opts: {
  productId: string;
  name: string;
  price: number;
  currency: string;
  type: 'consumable' | 'non_consumable';
  extraRegions?: RegionPrice[];
  packageName: string;
  serviceAccountKey: string;
}): Promise<CreateOneTimePurchaseResult> {
  try {
    const token = await getCachedToken(opts.serviceAccountKey);
    const pkg = encodeURIComponent(opts.packageName);

    const primaryRegionCode = currencyToRegionCode(opts.currency);
    const prices: Record<string, { currency: string; priceMicros: string }> = {
      [primaryRegionCode]: { currency: opts.currency, priceMicros: toGooglePriceMicros(opts.price, opts.currency) },
    };
    for (const region of opts.extraRegions ?? []) {
      const code = currencyToRegionCode(region.currency);
      prices[code] = { currency: region.currency, priceMicros: toGooglePriceMicros(region.price, region.currency) };
    }

    const body: InAppProductResource = {
      packageName: opts.packageName,
      sku: opts.productId,
      status: 'active',
      purchaseType: 'managedUser',
      listings: { 'en-US': { title: opts.name, description: '' } },
      prices,
    };

    await playRequest<InAppProductResource>(token, 'POST', `${ANDROID_BASE}/${pkg}/inappproducts`, body);
    return { success: true, productId: opts.productId };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Update the display name of a subscription or IAP product.
 */
export async function updateProduct(opts: {
  productId: string;
  productType: GoogleProductType;
  name?: string;
  packageName: string;
  serviceAccountKey: string;
}): Promise<UpdateProductResult> {
  if (!opts.name) return { success: true, updated: [], error: 'Nothing to update — provide at least one field to change.' };
  try {
    const token = await getCachedToken(opts.serviceAccountKey);
    const pkg = encodeURIComponent(opts.packageName);
    const updated: string[] = [];

    if (opts.productType === 'subscription') {
      // PATCH listing title via subscriptions.patch
      await playRequest<GoogleSubscriptionResource>(
        token, 'PATCH',
        `${ANDROID_BASE}/${pkg}/subscriptions/${encodeURIComponent(opts.productId)}?updateMask=listings`,
        { listings: [{ languageCode: 'en-US', title: opts.name }] },
      );
    } else {
      // PATCH inappproducts listing
      await playRequest<InAppProductResource>(
        token, 'PATCH',
        `${ANDROID_BASE}/${pkg}/inappproducts/${encodeURIComponent(opts.productId)}`,
        { listings: { 'en-US': { title: opts.name } } },
      );
    }
    updated.push('name');
    return { success: true, updated };
  } catch (err) {
    return { success: false, updated: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Delete a subscription or IAP product from Google Play.
 * Subscriptions can only be deleted if they have no active base plans with subscribers.
 */
export async function deleteProduct(opts: {
  productId: string;
  productType: GoogleProductType;
  packageName: string;
  serviceAccountKey: string;
}): Promise<DeleteProductResult> {
  try {
    const token = await getCachedToken(opts.serviceAccountKey);
    const pkg = encodeURIComponent(opts.packageName);

    if (opts.productType === 'subscription') {
      await playRequest<Record<string, unknown>>(
        token, 'DELETE',
        `${ANDROID_BASE}/${pkg}/subscriptions/${encodeURIComponent(opts.productId)}`,
      );
    } else {
      await playRequest<Record<string, unknown>>(
        token, 'DELETE',
        `${ANDROID_BASE}/${pkg}/inappproducts/${encodeURIComponent(opts.productId)}`,
      );
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * List all subscription and one-time IAP products for an app.
 */
export async function listProducts(opts: {
  packageName: string;
  serviceAccountKey: string;
}): Promise<GoogleProductRecord[]> {
  const token = await getCachedToken(opts.serviceAccountKey);
  const pkg = encodeURIComponent(opts.packageName);
  const results: GoogleProductRecord[] = [];

  // Subscriptions
  try {
    const resp = await playRequest<GoogleSubscriptionListResponse>(
      token, 'GET', `${ANDROID_BASE}/${pkg}/subscriptions`,
    );
    for (const sub of resp.subscriptions ?? []) {
      if (!sub.productId) continue;
      const listing = sub.listings?.find((l) => l.languageCode === 'en-US') ?? sub.listings?.[0];
      const basePlan = sub.basePlans?.[0];
      const rc = basePlan?.regionalConfigs?.[0];
      let price: number | undefined;
      let currency: string | undefined;
      if (rc?.price) {
        currency = rc.price.currencyCode;
        price = parseInt(rc.price.units, 10) * 100 + Math.round(rc.price.nanos / 10_000_000);
      }
      results.push({ productId: sub.productId, name: listing?.title, status: basePlan?.state, type: 'subscription', price, currency });
    }
  } catch { /* non-fatal */ }

  // One-time products
  try {
    const resp = await playRequest<InAppProductListResponse>(
      token, 'GET', `${ANDROID_BASE}/${pkg}/inappproducts`,
    );
    for (const item of resp.inappproduct ?? []) {
      if (!item.sku) continue;
      const title = item.listings?.['en-US']?.title ?? item.listings?.[Object.keys(item.listings ?? {})[0]]?.title;
      const priceEntry = item.prices ? Object.values(item.prices)[0] : undefined;
      let price: number | undefined;
      let currency: string | undefined;
      if (priceEntry) {
        currency = priceEntry.currency;
        const micros = parseInt(priceEntry.priceMicros, 10);
        price = ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase())
          ? Math.round(micros / 1_000_000)
          : Math.round(micros / 10_000);
      }
      // Google Play doesn't distinguish consumable/non-consumable at API level
      results.push({ productId: item.sku, name: title, status: item.status, type: 'consumable', price, currency });
    }
  } catch { /* non-fatal */ }

  return results;
}
