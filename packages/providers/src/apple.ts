/**
 * Apple App Store Connect API v3 — IAP product management.
 * https://developer.apple.com/documentation/appstoreconnectapi
 *
 * Covers: subscriptions, consumables, non-consumables — create / update / delete / list.
 * Authentication: ES256 JWT signed with a P8 private key (native Node.js crypto).
 */

import { createSign } from 'crypto';

import { ZERO_DECIMAL_CURRENCIES, SUPPORTED_CURRENCIES, unsupportedCurrencyError } from './currency.js';
import { MAX_RETRIES, isRetryableStatus, retryDelayMs, backoff } from './retry.js';

const BASE_URL = 'https://api.appstoreconnect.apple.com/v1';

// The standalone in-app purchase resource (create / patch / delete / pricePoints)
// lives under the v2 base — POST /v1/inAppPurchasesV2 is rejected with
// "path does not match a defined resource type". Only the app→IAP relationship
// (/v1/apps/{id}/inAppPurchasesV2) and price schedules
// (/v1/inAppPurchasePriceSchedules) remain on v1.
const IAP_V2_URL = 'https://api.appstoreconnect.apple.com/v2/inAppPurchases';

// ── KRW price tier reference ──────────────────────────────────────────────────

export const APPLE_KRW_COMMON_PRICES = [
  1100, 1400, 1700, 2200, 2700, 3300, 3900, 4400, 4900, 5400, 5900, 6600,
  7700, 8800, 9900, 11000, 13000, 15000, 17000, 19000, 22000, 25000, 29000,
  33000, 39000, 44000, 49000, 55000, 59000, 65000, 69000, 79000, 89000, 99000,
];

// ── Public types ──────────────────────────────────────────────────────────────

export interface AppleCredentials {
  keyId: string;
  issuerId: string;
  /** Contents of the .p8 private key file */
  privateKey: string;
}

export interface RegionPrice {
  /** ISO 4217 currency code (USD, KRW, EUR, …) */
  currency: string;
  /** Price in the smallest unit (cents for USD, whole units for KRW/JPY, …) */
  price: number;
}

export interface PricePointMatch {
  id: string;
  price: string;
}

export interface FindPricePointResult {
  exact: PricePointMatch | null;
  nearest: PricePointMatch[];
}

export type AppleProductType = 'subscription' | 'consumable' | 'non_consumable';

export interface CreateSubscriptionResult {
  success: boolean;
  productId?: string;
  internalId?: string;
  priceSet?: boolean;
  priceNearest?: PricePointMatch[];
  /** Why the price could not be set (unsupported currency, API error) — absent when priceSet is true. */
  priceError?: string;
  extraRegionsSet?: string[];
  localizationAdded?: boolean;
  error?: string;
  errorType?: 'DUPLICATE' | 'AUTH' | 'RELATIONSHIP' | 'PRICE_NOT_FOUND' | 'UNKNOWN';
}

export interface CreateOneTimePurchaseResult {
  success: boolean;
  productId?: string;
  internalId?: string;
  priceSet?: boolean;
  priceNearest?: PricePointMatch[];
  /** Why the price could not be set (unsupported currency, API error) — absent when priceSet is true. */
  priceError?: string;
  extraRegionsSet?: string[];
  error?: string;
  errorType?: 'DUPLICATE' | 'AUTH' | 'RELATIONSHIP' | 'PRICE_NOT_FOUND' | 'UNKNOWN';
}

export interface UpdateProductResult {
  success: boolean;
  updated: string[];
  error?: string;
  errorType?: 'NOT_FOUND' | 'AUTH' | 'UNKNOWN';
}

export interface DeleteProductResult {
  success: boolean;
  error?: string;
  /** CANNOT_DELETE means the product is published/approved and cannot be removed via API. */
  errorType?: 'CANNOT_DELETE' | 'NOT_FOUND' | 'AUTH' | 'UNKNOWN';
}

export interface AppleProductRecord {
  productId: string;
  internalId: string;
  name?: string;
  status?: string;
  type?: 'subscription' | 'consumable' | 'non_consumable' | 'unknown';
  price?: number;
  currency?: string;
}

// ── Internal API types ────────────────────────────────────────────────────────

interface AppleApiError {
  status: string;
  code: string;
  title: string;
  detail?: string;
  source?: { pointer?: string };
}

interface AppleAppListResponse {
  data: Array<{ id: string; attributes: { bundleId: string } }>;
  errors?: AppleApiError[];
}

interface AppleSubscriptionGroupResponse {
  data: { id: string };
  errors?: AppleApiError[];
}

interface AppleSubscriptionResponse {
  data: { id: string; attributes: { productId: string; state: string } };
  errors?: AppleApiError[];
}

interface ApplePricePointsResponse {
  data: Array<{
    id: string;
    attributes: { customerPrice: string };
    relationships?: { territory?: { data: { id: string } } };
  }>;
  links?: { next?: string };
}

interface AppleInAppPurchaseResponse {
  data: { id: string; attributes: { productId?: string; state?: string } };
  errors?: AppleApiError[];
}

interface AppleInAppPurchaseListResponse {
  data: Array<{
    id: string;
    attributes: {
      name?: string;
      productId?: string;
      inAppPurchaseType?: string;
      state?: string;
      referenceName?: string;
    };
  }>;
  links?: { next?: string };
  errors?: AppleApiError[];
}

interface AppleSubscriptionGroupListResponse {
  data: Array<{
    id: string;
    attributes: { referenceName?: string };
    relationships?: { subscriptions?: { data: Array<{ id: string }> } };
  }>;
  included?: Array<{
    id: string;
    type: string;
    attributes: { name?: string; productId?: string; subscriptionPeriod?: string; state?: string };
  }>;
  links?: { next?: string };
  errors?: AppleApiError[];
}

// ── JWT ──────────────────────────────────────────────────────────────────────

function generateJwt(creds: AppleCredentials): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: creds.keyId, typ: 'JWT' })).toString('base64url');
  // 19 min — Apple rejects exp more than 20 min out, so leave clock-skew headroom.
  const payload = Buffer.from(JSON.stringify({
    iss: creds.issuerId, iat: now, exp: now + 1140, aud: 'appstoreconnect-v1',
  })).toString('base64url');
  const input = `${header}.${payload}`;
  const sign = createSign('SHA256');
  sign.update(input);
  const sig = sign.sign({ key: creds.privateKey, dsaEncoding: 'ieee-p1363' }, 'base64url');
  return `${input}.${sig}`;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function appleRequest<T>(
  creds: AppleCredentials,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = path.startsWith('https://') ? path : `${BASE_URL}${path}`;
  for (let attempt = 0; ; attempt++) {
    // JWT is generated per attempt — a Retry-After wait must not push a reused
    // token past its 20-min expiry window.
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${generateJwt(creds)}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await resp.text();
    // ASC hourly rate limits surface as 429 (503 for transient outages) —
    // retry a bounded number of times before surfacing the usual error shape.
    if (isRetryableStatus(resp.status) && attempt < MAX_RETRIES) {
      await backoff.sleep(retryDelayMs(attempt, resp.headers?.get('retry-after')));
      continue;
    }
    // DELETE returns 204 No Content — JSON.parse('') would throw on a successful call.
    if (resp.ok && text.trim() === '') return undefined as T;
    let json: T;
    try { json = JSON.parse(text) as T; }
    catch { throw new Error(`Apple API ${resp.status}: non-JSON — ${text.slice(0, 200)}`); }
    if (!resp.ok) {
      const errors = (json as { errors?: AppleApiError[] }).errors ?? [];
      const detail = errors.map((e) => `${e.code}: ${e.detail ?? e.title}`).join('; ') || `HTTP ${resp.status}`;
      const err = new Error(`Apple API error — ${detail}`) as Error & { appleErrors: AppleApiError[]; httpStatus: number };
      err.appleErrors = errors;
      err.httpStatus = resp.status;
      throw err;
    }
    return json;
  }
}

/**
 * Iterate every page of a paginated App Store Connect GET endpoint, following
 * `links.next` until exhausted. Yields whole pages (call sites pick `data` vs
 * `included`); breaking out of the `for await` stops fetching further pages.
 */
async function* applePages<T extends { links?: { next?: string } }>(
  creds: AppleCredentials,
  firstPath: string,
): AsyncGenerator<T, void, undefined> {
  let next: string | undefined = firstPath;
  while (next) {
    const page: T = await appleRequest<T>(creds, 'GET', next);
    yield page;
    next = page.links?.next;
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export async function resolveAppId(creds: AppleCredentials, bundleId: string): Promise<string | null> {
  const data = await appleRequest<AppleAppListResponse>(creds, 'GET', `/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`);
  return data.data?.[0]?.id ?? null;
}

// Apple territory ↔ currency mappings derive from the shared table in
// currency.ts (single source of truth with the Google region codes).
const TERRITORY_CURRENCY: Record<string, string> = Object.fromEntries(
  Object.entries(SUPPORTED_CURRENCIES).map(([currency, { appleTerritory }]) => [appleTerritory, currency]),
);

export async function findPricePoint(
  creds: AppleCredentials,
  resourceType: 'subscriptions' | 'inAppPurchasesV2',
  resourceId: string,
  territory: string,
  targetPrice: number,
  currency?: string,
): Promise<FindPricePointResult> {
  const all: PricePointMatch[] = [];
  const pricePointsBase =
    resourceType === 'inAppPurchasesV2'
      ? `${IAP_V2_URL}/${encodeURIComponent(resourceId)}/pricePoints`
      : `/${resourceType}/${encodeURIComponent(resourceId)}/pricePoints`;
  const firstPath =
    `${pricePointsBase}?filter[territory]=${encodeURIComponent(territory)}&limit=200`;
  for await (const page of applePages<ApplePricePointsResponse>(creds, firstPath)) {
    for (const item of page.data ?? []) {
      all.push({ id: item.id, price: item.attributes.customerPrice });
    }
  }
  // customerPrice is in major units ("4.99") while targetPrice is in the
  // smallest unit (499 cents) — normalize before comparing. When the currency
  // is unknown (external caller with an unmapped territory and no currency
  // arg), compare in major units: scaling by 100 would silently break every
  // zero-decimal-currency territory outside the map (TWN, VNM, …).
  const cc = (currency ?? TERRITORY_CURRENCY[territory] ?? '').toUpperCase();
  const scale = cc === '' || ZERO_DECIMAL_CURRENCIES.has(cc) ? 1 : 100;
  const toSmallestUnit = (price: string): number => Math.round(parseFloat(price) * scale);
  const exact = all.find((p) => toSmallestUnit(p.price) === targetPrice) ?? null;
  const sorted = all
    .filter((p) => p !== exact)
    .sort((a, b) => Math.abs(toSmallestUnit(a.price) - targetPrice) - Math.abs(toSmallestUnit(b.price) - targetPrice));
  return { exact, nearest: sorted.slice(0, 3) };
}

function currencyToTerritory(currency: string): string | undefined {
  return SUPPORTED_CURRENCIES[currency.toUpperCase()]?.appleTerritory;
}

function toSubscriptionPeriod(period: string): string {
  if (period === 'yearly' || period === 'ONE_YEAR') return 'ONE_YEAR';
  return 'ONE_MONTH';
}

function translateAppleError(
  errors: AppleApiError[],
  httpStatus: number,
  productId: string,
): { message: string; errorType: CreateSubscriptionResult['errorType'] } {
  if (httpStatus === 401 || httpStatus === 403) {
    return { message: 'API key is invalid or expired. Check keyId, issuerId, and privateKey.', errorType: 'AUTH' };
  }
  for (const e of errors) {
    if (e.code === 'ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE') {
      return { message: `Product ID '${productId}' already exists in App Store Connect.`, errorType: 'DUPLICATE' };
    }
    if (e.code === 'ENTITY_ERROR.RELATIONSHIP.INVALID') {
      const hint = (e.source?.pointer ?? '').includes('app')
        ? ' The App ID does not exist or the key lacks access to it.'
        : '';
      return { message: `Relationship error: ${e.detail ?? e.title}.${hint}`, errorType: 'RELATIONSHIP' };
    }
  }
  const raw = errors.map((e) => `${e.code}: ${e.detail ?? e.title}`).join('; ');
  return { message: raw || `HTTP ${httpStatus}`, errorType: 'UNKNOWN' };
}

async function resolveAppIdFromOpts(
  creds: AppleCredentials,
  appId?: string,
  bundleId?: string,
): Promise<{ appId: string } | { error: string }> {
  if (appId) return { appId };
  if (!bundleId) return { error: 'Either appId or bundleId must be provided.' };
  const resolved = await resolveAppId(creds, bundleId);
  if (!resolved) return { error: `Could not resolve App ID for bundle ID '${bundleId}'.` };
  return { appId: resolved };
}

async function setPrice(
  creds: AppleCredentials,
  resourceType: 'subscriptions' | 'inAppPurchasesV2',
  resourceId: string,
  currency: string,
  price: number,
): Promise<{ priceSet: boolean; priceNearest?: PricePointMatch[]; priceError?: string }> {
  const territory = currencyToTerritory(currency);
  if (!territory) {
    return { priceSet: false, priceError: unsupportedCurrencyError(currency) };
  }
  try {
    const result = await findPricePoint(creds, resourceType, resourceId, territory, price, currency);
    if (result.exact) {
      if (resourceType === 'subscriptions') {
        await appleRequest(creds, 'POST', '/subscriptionPrices', {
          data: {
            type: 'subscriptionPrices',
            attributes: { preserveCurrentPrice: false, startDate: null },
            relationships: {
              subscription: { data: { type: 'subscriptions', id: resourceId } },
              subscriptionPricePoint: { data: { type: 'subscriptionPricePoints', id: result.exact.id } },
            },
          },
        });
      } else {
        // IAP price schedule
        const tempId = 'p_0';
        await appleRequest(creds, 'POST', '/inAppPurchasePriceSchedules', {
          data: {
            type: 'inAppPurchasePriceSchedules',
            relationships: {
              inAppPurchase: { data: { type: 'inAppPurchases', id: resourceId } },
              baseTerritory: { data: { type: 'territories', id: territory } },
              manualPrices: { data: [{ type: 'inAppPurchasePrices', id: tempId }] },
            },
          },
          included: [{
            type: 'inAppPurchasePrices',
            id: tempId,
            attributes: { startDate: null },
            relationships: {
              inAppPurchasePricePoint: { data: { type: 'inAppPurchasePricePoints', id: result.exact.id } },
            },
          }],
        });
      }
      return { priceSet: true };
    }
    return { priceSet: false, priceNearest: result.nearest };
  } catch (err) {
    return { priceSet: false, priceError: err instanceof Error ? err.message : String(err) };
  }
}

async function setExtraRegionPrices(
  creds: AppleCredentials,
  resourceType: 'subscriptions' | 'inAppPurchasesV2',
  resourceId: string,
  extraRegions: RegionPrice[],
): Promise<string[]> {
  const set: string[] = [];
  for (const region of extraRegions) {
    const result = await setPrice(creds, resourceType, resourceId, region.currency, region.price);
    if (result.priceSet) set.push(region.currency);
  }
  return set;
}

// ── Internal lookup helpers ───────────────────────────────────────────────────

interface SubscriptionLookup { internalId: string; state: string }
interface IapLookup { internalId: string; state: string }

// These deliberately do NOT swallow request errors: an auth failure or rate
// limit must not masquerade as NOT_FOUND (callers map 401/403 to AUTH).
async function findSubscriptionByProductId(
  creds: AppleCredentials,
  appId: string,
  productId: string,
): Promise<SubscriptionLookup | null> {
  for await (const resp of applePages<AppleSubscriptionGroupListResponse>(
    creds, `/apps/${encodeURIComponent(appId)}/subscriptionGroups?include=subscriptions&limit=50`,
  )) {
    for (const item of resp.included ?? []) {
      if (item.type === 'subscriptions' && item.attributes.productId === productId) {
        return { internalId: item.id, state: item.attributes.state ?? '' };
      }
    }
  }
  return null;
}

async function findIapByProductId(
  creds: AppleCredentials,
  appId: string,
  productId: string,
): Promise<IapLookup | null> {
  for await (const resp of applePages<AppleInAppPurchaseListResponse>(
    creds, `/apps/${encodeURIComponent(appId)}/inAppPurchasesV2?limit=200`,
  )) {
    for (const item of resp.data ?? []) {
      if (item.attributes.productId === productId) {
        return { internalId: item.id, state: item.attributes.state ?? '' };
      }
    }
  }
  return null;
}

async function findSubscriptionGroupByName(
  creds: AppleCredentials,
  appId: string,
  referenceName: string,
): Promise<string | null> {
  for await (const resp of applePages<AppleSubscriptionGroupListResponse>(
    creds, `/apps/${encodeURIComponent(appId)}/subscriptionGroups?limit=50`,
  )) {
    for (const item of resp.data ?? []) {
      if (item.attributes.referenceName === referenceName) return item.id;
    }
  }
  return null;
}

// ── Exported CRUD functions ───────────────────────────────────────────────────

/**
 * Create an auto-renewable subscription on App Store Connect.
 * Creates a subscription group + subscription, then sets price and (optionally) localization.
 */
export async function createSubscription(opts: {
  productId: string;
  name: string;
  price: number;
  currency: string;
  period: 'monthly' | 'yearly';
  extraRegions?: RegionPrice[];
  keyId: string;
  issuerId: string;
  privateKey: string;
  appId?: string;
  bundleId?: string;
}): Promise<CreateSubscriptionResult> {
  const creds: AppleCredentials = { keyId: opts.keyId, issuerId: opts.issuerId, privateKey: opts.privateKey };
  try {
    const resolved = await resolveAppIdFromOpts(creds, opts.appId, opts.bundleId);
    if ('error' in resolved) return { success: false, error: resolved.error, errorType: 'UNKNOWN' };
    const { appId } = resolved;

    // 1 — subscription group: reuse an existing group with the same reference
    // name (a previously failed create may have left one behind — recreating
    // would 409 DUPLICATE and misreport it as a duplicate productId).
    const referenceName = `${opts.name} Group`;
    let groupId: string;
    let groupCreated = false;
    try {
      const existingGroupId = await findSubscriptionGroupByName(creds, appId, referenceName);
      if (existingGroupId) {
        groupId = existingGroupId;
      } else {
        const gr = await appleRequest<AppleSubscriptionGroupResponse>(creds, 'POST', '/subscriptionGroups', {
          data: {
            type: 'subscriptionGroups',
            attributes: { referenceName },
            relationships: { app: { data: { type: 'apps', id: appId } } },
          },
        });
        groupId = gr.data.id;
        groupCreated = true;
      }
    } catch (err) {
      const e = err as Error & { appleErrors?: AppleApiError[]; httpStatus?: number };
      const { message, errorType } = translateAppleError(e.appleErrors ?? [], e.httpStatus ?? 0, opts.productId);
      return { success: false, error: message, errorType };
    }

    // 2 — subscription
    let subscriptionId: string;
    try {
      const sub = await appleRequest<AppleSubscriptionResponse>(creds, 'POST', '/subscriptions', {
        data: {
          type: 'subscriptions',
          attributes: { name: opts.name, productId: opts.productId, subscriptionPeriod: toSubscriptionPeriod(opts.period), reviewNote: '' },
          relationships: { group: { data: { type: 'subscriptionGroups', id: groupId } } },
        },
      });
      subscriptionId = sub.data.id;
    } catch (err) {
      // Roll back the group we just created so a retry starts clean.
      if (groupCreated) {
        try { await appleRequest(creds, 'DELETE', `/subscriptionGroups/${groupId}`); } catch { /* best-effort */ }
      }
      const e = err as Error & { appleErrors?: AppleApiError[]; httpStatus?: number };
      const { message, errorType } = translateAppleError(e.appleErrors ?? [], e.httpStatus ?? 0, opts.productId);
      return { success: false, error: message, errorType };
    }

    // 3 — primary price
    const { priceSet, priceNearest, priceError } = await setPrice(creds, 'subscriptions', subscriptionId, opts.currency, opts.price);

    // 4 — extra regions
    const extraRegionsSet = opts.extraRegions?.length
      ? await setExtraRegionPrices(creds, 'subscriptions', subscriptionId, opts.extraRegions)
      : [];

    // 5 — Korean localization for KRW
    let localizationAdded = false;
    if (opts.currency === 'KRW') {
      try {
        await appleRequest(creds, 'POST', '/subscriptionLocalizations', {
          data: {
            type: 'subscriptionLocalizations',
            attributes: { locale: 'ko', name: opts.name, description: opts.name },
            relationships: { subscription: { data: { type: 'subscriptions', id: subscriptionId } } },
          },
        });
        localizationAdded = true;
      } catch { /* non-fatal */ }
    }

    return { success: true, productId: opts.productId, internalId: subscriptionId, priceSet, priceNearest, priceError, extraRegionsSet, localizationAdded };
  } catch (err) {
    const e = err as Error & { appleErrors?: AppleApiError[]; httpStatus?: number };
    if (e.appleErrors) {
      const { message, errorType } = translateAppleError(e.appleErrors, e.httpStatus ?? 0, opts.productId);
      return { success: false, error: message, errorType };
    }
    return { success: false, error: err instanceof Error ? err.message : String(err), errorType: 'UNKNOWN' };
  }
}

/**
 * Create a consumable or non-consumable in-app purchase on App Store Connect.
 */
export async function createOneTimePurchase(opts: {
  productId: string;
  name: string;
  price: number;
  currency: string;
  type: 'consumable' | 'non_consumable';
  extraRegions?: RegionPrice[];
  keyId: string;
  issuerId: string;
  privateKey: string;
  appId?: string;
  bundleId?: string;
}): Promise<CreateOneTimePurchaseResult> {
  const creds: AppleCredentials = { keyId: opts.keyId, issuerId: opts.issuerId, privateKey: opts.privateKey };
  try {
    const resolved = await resolveAppIdFromOpts(creds, opts.appId, opts.bundleId);
    if ('error' in resolved) return { success: false, error: resolved.error, errorType: 'UNKNOWN' };
    const { appId } = resolved;

    const inAppPurchaseType = opts.type === 'consumable' ? 'CONSUMABLE' : 'NON_CONSUMABLE';

    let iapId: string;
    try {
      const resp = await appleRequest<AppleInAppPurchaseResponse>(creds, 'POST', IAP_V2_URL, {
        data: {
          type: 'inAppPurchases',
          attributes: { name: opts.name, productId: opts.productId, inAppPurchaseType },
          relationships: { app: { data: { type: 'apps', id: appId } } },
        },
      });
      iapId = resp.data.id;
    } catch (err) {
      const e = err as Error & { appleErrors?: AppleApiError[]; httpStatus?: number };
      const { message, errorType } = translateAppleError(e.appleErrors ?? [], e.httpStatus ?? 0, opts.productId);
      return { success: false, error: message, errorType };
    }

    // Set primary price
    const { priceSet, priceNearest, priceError } = await setPrice(creds, 'inAppPurchasesV2', iapId, opts.currency, opts.price);

    // Extra regions
    const extraRegionsSet = opts.extraRegions?.length
      ? await setExtraRegionPrices(creds, 'inAppPurchasesV2', iapId, opts.extraRegions)
      : [];

    return { success: true, productId: opts.productId, internalId: iapId, priceSet, priceNearest, priceError, extraRegionsSet };
  } catch (err) {
    const e = err as Error & { appleErrors?: AppleApiError[]; httpStatus?: number };
    if (e.appleErrors) {
      const { message, errorType } = translateAppleError(e.appleErrors, e.httpStatus ?? 0, opts.productId);
      return { success: false, error: message, errorType };
    }
    return { success: false, error: err instanceof Error ? err.message : String(err), errorType: 'UNKNOWN' };
  }
}

/**
 * Update the reference name of a subscription or IAP product.
 * Apple does not allow changing productId or type after creation.
 */
export async function updateProduct(opts: {
  productId: string;
  productType: AppleProductType;
  name?: string;
  keyId: string;
  issuerId: string;
  privateKey: string;
  appId?: string;
  bundleId?: string;
}): Promise<UpdateProductResult> {
  const creds: AppleCredentials = { keyId: opts.keyId, issuerId: opts.issuerId, privateKey: opts.privateKey };
  try {
    const resolved = await resolveAppIdFromOpts(creds, opts.appId, opts.bundleId);
    if ('error' in resolved) return { success: false, updated: [], error: resolved.error, errorType: 'UNKNOWN' };
    const { appId } = resolved;

    const updated: string[] = [];

    if (opts.productType === 'subscription') {
      const found = await findSubscriptionByProductId(creds, appId, opts.productId);
      if (!found) return { success: false, updated: [], error: `Subscription '${opts.productId}' not found.`, errorType: 'NOT_FOUND' };
      if (opts.name) {
        await appleRequest(creds, 'PATCH', `/subscriptions/${found.internalId}`, {
          data: { type: 'subscriptions', id: found.internalId, attributes: { name: opts.name } },
        });
        updated.push('name');
      }
    } else {
      const found = await findIapByProductId(creds, appId, opts.productId);
      if (!found) return { success: false, updated: [], error: `IAP '${opts.productId}' not found.`, errorType: 'NOT_FOUND' };
      if (opts.name) {
        await appleRequest(creds, 'PATCH', `${IAP_V2_URL}/${found.internalId}`, {
          data: { type: 'inAppPurchases', id: found.internalId, attributes: { name: opts.name } },
        });
        updated.push('name');
      }
    }

    if (updated.length === 0) return { success: true, updated: [], error: 'Nothing to update — provide at least one field to change.' };
    return { success: true, updated };
  } catch (err) {
    const e = err as Error & { appleErrors?: AppleApiError[]; httpStatus?: number };
    if (e.httpStatus === 401 || e.httpStatus === 403) return { success: false, updated: [], error: e.message, errorType: 'AUTH' };
    return { success: false, updated: [], error: err instanceof Error ? err.message : String(err), errorType: 'UNKNOWN' };
  }
}

/**
 * Delete a subscription or IAP product.
 * Only products in MISSING_METADATA or WAITING_FOR_REVIEW state can be deleted via API.
 * Published (READY_FOR_SALE) products must be removed from sale via App Store Connect.
 */
export async function deleteProduct(opts: {
  productId: string;
  productType: AppleProductType;
  keyId: string;
  issuerId: string;
  privateKey: string;
  appId?: string;
  bundleId?: string;
}): Promise<DeleteProductResult> {
  const creds: AppleCredentials = { keyId: opts.keyId, issuerId: opts.issuerId, privateKey: opts.privateKey };
  try {
    const resolved = await resolveAppIdFromOpts(creds, opts.appId, opts.bundleId);
    if ('error' in resolved) return { success: false, error: resolved.error, errorType: 'UNKNOWN' };
    const { appId } = resolved;

    if (opts.productType === 'subscription') {
      const found = await findSubscriptionByProductId(creds, appId, opts.productId);
      if (!found) return { success: false, error: `Subscription '${opts.productId}' not found.`, errorType: 'NOT_FOUND' };
      await appleRequest(creds, 'DELETE', `/subscriptions/${found.internalId}`);
    } else {
      const found = await findIapByProductId(creds, appId, opts.productId);
      if (!found) return { success: false, error: `IAP '${opts.productId}' not found.`, errorType: 'NOT_FOUND' };
      await appleRequest(creds, 'DELETE', `${IAP_V2_URL}/${found.internalId}`);
    }

    return { success: true };
  } catch (err) {
    const e = err as Error & { appleErrors?: AppleApiError[]; httpStatus?: number };
    if (e.httpStatus === 401 || e.httpStatus === 403) return { success: false, error: e.message, errorType: 'AUTH' };
    // Apple returns 409 Conflict when the product cannot be deleted (already approved)
    if (e.httpStatus === 409) {
      return {
        success: false,
        error: `Product '${opts.productId}' cannot be deleted — it has been approved or submitted for review. Use App Store Connect to remove it from sale instead.`,
        errorType: 'CANNOT_DELETE',
      };
    }
    return { success: false, error: err instanceof Error ? err.message : String(err), errorType: 'UNKNOWN' };
  }
}

/**
 * List all IAP products (subscriptions + one-time purchases) for an app.
 */
export async function listProducts(opts: {
  keyId: string;
  issuerId: string;
  privateKey: string;
  appId: string;
}): Promise<AppleProductRecord[]> {
  const creds: AppleCredentials = { keyId: opts.keyId, issuerId: opts.issuerId, privateKey: opts.privateKey };
  const results: AppleProductRecord[] = [];
  const failures: unknown[] = [];

  try {
    for await (const iapResp of applePages<AppleInAppPurchaseListResponse>(
      creds, `/apps/${encodeURIComponent(opts.appId)}/inAppPurchasesV2?limit=200`,
    )) {
      for (const item of iapResp.data ?? []) {
        const rawType = item.attributes.inAppPurchaseType ?? '';
        const type: AppleProductRecord['type'] =
          rawType === 'CONSUMABLE' ? 'consumable' :
          rawType === 'NON_CONSUMABLE' ? 'non_consumable' : 'unknown';
        results.push({
          productId: item.attributes.productId ?? item.id,
          internalId: item.id,
          name: item.attributes.name ?? item.attributes.referenceName,
          status: item.attributes.state,
          type,
        });
      }
    }
  } catch (err) { failures.push(err); }

  try {
    for await (const groupsResp of applePages<AppleSubscriptionGroupListResponse>(
      creds, `/apps/${encodeURIComponent(opts.appId)}/subscriptionGroups?include=subscriptions&limit=50`,
    )) {
      for (const item of groupsResp.included ?? []) {
        if (item.type !== 'subscriptions') continue;
        results.push({
          productId: item.attributes.productId ?? item.id,
          internalId: item.id,
          name: item.attributes.name,
          status: item.attributes.state,
          type: 'subscription',
        });
      }
    }
  } catch (err) { failures.push(err); }

  // A single half failing is tolerable (partial list); both failing means the
  // caller would mistake an auth/network problem for an empty catalog.
  if (failures.length === 2) throw failures[0];

  return results;
}
