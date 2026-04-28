/**
 * Apple App Store Connect API v3 — IAP product management.
 * https://developer.apple.com/documentation/appstoreconnectapi
 *
 * Covers: subscriptions, consumables, non-consumables — create / update / delete / list.
 * Authentication: ES256 JWT signed with a P8 private key (native Node.js crypto).
 */

import { createSign } from 'crypto';

const BASE_URL = 'https://api.appstoreconnect.apple.com/v1';

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
  errors?: AppleApiError[];
}

// ── JWT ──────────────────────────────────────────────────────────────────────

function generateJwt(creds: AppleCredentials): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: creds.keyId, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: creds.issuerId, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1',
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
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${generateJwt(creds)}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
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

// ── Utilities ─────────────────────────────────────────────────────────────────

export async function resolveAppId(creds: AppleCredentials, bundleId: string): Promise<string | null> {
  const data = await appleRequest<AppleAppListResponse>(creds, 'GET', `/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`);
  return data.data?.[0]?.id ?? null;
}

export async function findPricePoint(
  creds: AppleCredentials,
  resourceType: 'subscriptions' | 'inAppPurchasesV2',
  resourceId: string,
  territory: string,
  targetPrice: number,
): Promise<FindPricePointResult> {
  const all: PricePointMatch[] = [];
  let nextPath: string | undefined =
    `/${resourceType}/${encodeURIComponent(resourceId)}/pricePoints` +
    `?filter[territory]=${encodeURIComponent(territory)}&limit=200`;
  while (nextPath) {
    const page: ApplePricePointsResponse = await appleRequest<ApplePricePointsResponse>(creds, 'GET', nextPath);
    for (const item of page.data ?? []) {
      all.push({ id: item.id, price: item.attributes.customerPrice });
    }
    nextPath = page.links?.next;
  }
  const exact = all.find((p) => Math.round(parseFloat(p.price)) === targetPrice) ?? null;
  const sorted = all
    .filter((p) => p !== exact)
    .sort((a, b) => Math.abs(parseFloat(a.price) - targetPrice) - Math.abs(parseFloat(b.price) - targetPrice));
  return { exact, nearest: sorted.slice(0, 3) };
}

function currencyToTerritory(currency: string): string | undefined {
  const map: Record<string, string> = {
    KRW: 'KOR', USD: 'USA', EUR: 'EUR', JPY: 'JPN',
    GBP: 'GBR', AUD: 'AUS', CAD: 'CAN', CNY: 'CHN', SGD: 'SGP',
  };
  return map[currency.toUpperCase()];
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
): Promise<{ priceSet: boolean; priceNearest?: PricePointMatch[] }> {
  const territory = currencyToTerritory(currency);
  if (!territory) return { priceSet: false };
  try {
    const result = await findPricePoint(creds, resourceType, resourceId, territory, price);
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
  } catch {
    return { priceSet: false };
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

async function findSubscriptionByProductId(
  creds: AppleCredentials,
  appId: string,
  productId: string,
): Promise<SubscriptionLookup | null> {
  try {
    const resp = await appleRequest<AppleSubscriptionGroupListResponse>(
      creds, 'GET',
      `/apps/${encodeURIComponent(appId)}/subscriptionGroups?include=subscriptions`,
    );
    for (const item of resp.included ?? []) {
      if (item.type === 'subscriptions' && item.attributes.productId === productId) {
        return { internalId: item.id, state: item.attributes.state ?? '' };
      }
    }
  } catch { /* not found */ }
  return null;
}

async function findIapByProductId(
  creds: AppleCredentials,
  appId: string,
  productId: string,
): Promise<IapLookup | null> {
  try {
    const resp = await appleRequest<AppleInAppPurchaseListResponse>(
      creds, 'GET',
      `/apps/${encodeURIComponent(appId)}/inAppPurchasesV2`,
    );
    for (const item of resp.data ?? []) {
      if (item.attributes.productId === productId) {
        return { internalId: item.id, state: item.attributes.state ?? '' };
      }
    }
  } catch { /* not found */ }
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

    // 1 — subscription group
    let groupId: string;
    try {
      const gr = await appleRequest<AppleSubscriptionGroupResponse>(creds, 'POST', '/subscriptionGroups', {
        data: {
          type: 'subscriptionGroups',
          attributes: { referenceName: `${opts.name} Group` },
          relationships: { app: { data: { type: 'apps', id: appId } } },
        },
      });
      groupId = gr.data.id;
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
      const e = err as Error & { appleErrors?: AppleApiError[]; httpStatus?: number };
      const { message, errorType } = translateAppleError(e.appleErrors ?? [], e.httpStatus ?? 0, opts.productId);
      return { success: false, error: message, errorType };
    }

    // 3 — primary price
    const { priceSet, priceNearest } = await setPrice(creds, 'subscriptions', subscriptionId, opts.currency, opts.price);

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

    return { success: true, productId: opts.productId, internalId: subscriptionId, priceSet, priceNearest, extraRegionsSet, localizationAdded };
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
      const resp = await appleRequest<AppleInAppPurchaseResponse>(creds, 'POST', '/inAppPurchasesV2', {
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
    const { priceSet, priceNearest } = await setPrice(creds, 'inAppPurchasesV2', iapId, opts.currency, opts.price);

    // Extra regions
    const extraRegionsSet = opts.extraRegions?.length
      ? await setExtraRegionPrices(creds, 'inAppPurchasesV2', iapId, opts.extraRegions)
      : [];

    return { success: true, productId: opts.productId, internalId: iapId, priceSet, priceNearest, extraRegionsSet };
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
        await appleRequest(creds, 'PATCH', `/inAppPurchasesV2/${found.internalId}`, {
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
      await appleRequest(creds, 'DELETE', `/inAppPurchasesV2/${found.internalId}`);
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

  try {
    const iapResp = await appleRequest<AppleInAppPurchaseListResponse>(
      creds, 'GET', `/apps/${encodeURIComponent(opts.appId)}/inAppPurchasesV2`,
    );
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
  } catch { /* non-fatal */ }

  try {
    const groupsResp = await appleRequest<AppleSubscriptionGroupListResponse>(
      creds, 'GET',
      `/apps/${encodeURIComponent(opts.appId)}/subscriptionGroups?include=subscriptions`,
    );
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
  } catch { /* non-fatal */ }

  return results;
}
