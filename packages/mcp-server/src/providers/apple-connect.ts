/**
 * Apple App Store Connect API v3 — subscription product management.
 * https://developer.apple.com/documentation/appstoreconnectapi
 *
 * Authentication: ES256 JWT signed with a P8 private key.
 * No external JWT library is required — uses Node.js native `crypto`.
 */

import { createSign } from 'crypto';

const BASE_URL = 'https://api.appstoreconnect.apple.com/v1';

// ---------------------------------------------------------------------------
// KRW price tier reference
// ---------------------------------------------------------------------------

/**
 * Apple's common KRW price tiers as of 2024.
 * Apple does not allow arbitrary prices — you must choose from their fixed tiers.
 * Source: App Store Connect price schedule for Korea (KRW).
 */
export const APPLE_KRW_COMMON_PRICES = [
  1100, 1400, 1700, 2200, 2700, 3300, 3900, 4400, 4900, 5400, 5900, 6600,
  7700, 8800, 9900, 11000, 13000, 15000, 17000, 19000, 22000, 25000, 29000,
  33000, 39000, 44000, 49000, 55000, 59000, 65000, 69000, 79000, 89000, 99000,
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppleConnectConfig {
  keyId: string;
  issuerId: string;
  /** Contents of the .p8 private key file */
  privateKey: string;
}

interface AppleAppListResponse {
  data: Array<{
    id: string;
    type: string;
    attributes: {
      bundleId: string;
      name?: string;
    };
  }>;
  errors?: AppleApiError[];
}

interface AppleSubscriptionGroupResponse {
  data: {
    id: string;
    type: string;
    attributes: {
      referenceName: string;
    };
  };
  errors?: AppleApiError[];
}

interface AppleSubscriptionResponse {
  data: {
    id: string;
    type: string;
    attributes: {
      name: string;
      productId: string;
      subscriptionPeriod: string;
      state: string;
    };
  };
  errors?: AppleApiError[];
}

interface ApplePricePointsResponse {
  data: Array<{
    id: string;
    type: string;
    attributes: {
      customerPrice: string;
      proceeds: string;
    };
    relationships?: {
      territory?: {
        data: { id: string; type: string };
      };
    };
  }>;
  links?: {
    next?: string;
  };
  errors?: AppleApiError[];
}

interface AppleInAppPurchaseListResponse {
  data: Array<{
    id: string;
    type: string;
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
    type: string;
    attributes: {
      referenceName?: string;
    };
    relationships?: {
      subscriptions?: {
        data: Array<{ id: string; type: string }>;
      };
    };
  }>;
  included?: Array<{
    id: string;
    type: string;
    attributes: {
      name?: string;
      productId?: string;
      subscriptionPeriod?: string;
      state?: string;
    };
  }>;
  errors?: AppleApiError[];
}

interface AppleApiError {
  status: string;
  code: string;
  title: string;
  detail?: string;
  source?: {
    pointer?: string;
  };
}

export interface PricePointMatch {
  id: string;
  price: string;
}

export interface FindPricePointResult {
  exact: PricePointMatch | null;
  nearest: PricePointMatch[];
}

export interface CreateAppleSubscriptionResult {
  success: boolean;
  productId?: string;
  subscriptionId?: string;
  priceSet?: boolean;
  priceNearest?: PricePointMatch[];
  localizationAdded?: boolean;
  error?: string;
  /** Structured error type for the tool layer to produce better messages */
  errorType?: 'DUPLICATE' | 'AUTH' | 'RELATIONSHIP' | 'PRICE_NOT_FOUND' | 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// JWT generation
// ---------------------------------------------------------------------------

/**
 * Generate a short-lived App Store Connect API JWT (valid 20 minutes).
 * ES256 signature produced with the native `crypto` module.
 */
function generateJwt(config: AppleConnectConfig): string {
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(
    JSON.stringify({ alg: 'ES256', kid: config.keyId, typ: 'JWT' }),
  ).toString('base64url');

  const payload = Buffer.from(
    JSON.stringify({
      iss: config.issuerId,
      iat: now,
      exp: now + 1200, // 20 minutes — App Store Connect maximum
      aud: 'appstoreconnect-v1',
    }),
  ).toString('base64url');

  const signingInput = `${header}.${payload}`;

  const sign = createSign('SHA256');
  sign.update(signingInput);
  const signature = sign.sign(
    { key: config.privateKey, dsaEncoding: 'ieee-p1363' },
    'base64url',
  );

  return `${signingInput}.${signature}`;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function appleRequest<T>(
  config: AppleConnectConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = generateJwt(config);
  // path may be an absolute URL (pagination `links.next`) or a relative path
  const url = path.startsWith('https://') ? path : `${BASE_URL}${path}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const resp = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let json: T;
  try {
    json = JSON.parse(text) as T;
  } catch {
    throw new Error(`Apple API ${resp.status}: non-JSON response — ${text.slice(0, 200)}`);
  }

  if (!resp.ok) {
    const errBody = json as { errors?: AppleApiError[] };
    const errors = errBody.errors ?? [];

    // Attach raw error objects to the thrown error so callers can inspect them
    const detail =
      errors.map((e) => `${e.code}: ${e.detail ?? e.title}`).join('; ') ??
      `HTTP ${resp.status}`;

    const err = new Error(`Apple API error — ${detail}`) as Error & {
      appleErrors: AppleApiError[];
      httpStatus: number;
    };
    err.appleErrors = errors;
    err.httpStatus = resp.status;
    throw err;
  }

  return json;
}

// ---------------------------------------------------------------------------
// Exported helper functions
// ---------------------------------------------------------------------------

/**
 * Resolve a numeric App Store Connect App ID from a bundle ID.
 * Returns null if not found.
 */
export async function resolveAppId(
  config: AppleConnectConfig,
  bundleId: string,
): Promise<string | null> {
  const data = await appleRequest<AppleAppListResponse>(
    config,
    'GET',
    `/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`,
  );
  return data.data?.[0]?.id ?? null;
}

/**
 * Paginate through all price points for a subscription in a given territory
 * and return an exact match and the 3 nearest alternatives.
 *
 * Apple price points are keyed by territory (e.g. "KOR" for Korea, "USA" for US).
 * `targetPrice` is the customer-facing price as an integer (e.g. 29000 for ₩29,000).
 */
export async function findPricePoint(
  config: AppleConnectConfig,
  subscriptionId: string,
  territory: string,
  targetPrice: number,
): Promise<FindPricePointResult> {
  const all: PricePointMatch[] = [];

  let nextPath: string | undefined =
    `/subscriptions/${encodeURIComponent(subscriptionId)}/pricePoints` +
    `?filter[territory]=${encodeURIComponent(territory)}&limit=200`;

  while (nextPath !== undefined) {
    const currentPath: string = nextPath;
    nextPath = undefined;

    const page: ApplePricePointsResponse = await appleRequest<ApplePricePointsResponse>(
      config,
      'GET',
      currentPath,
    );

    for (const item of page.data ?? []) {
      all.push({
        id: item.id,
        price: item.attributes.customerPrice,
      });
    }

    nextPath = page.links?.next;
  }

  // Find exact match
  const exact = all.find((p) => Math.round(parseFloat(p.price)) === targetPrice) ?? null;

  // Sort by distance to target and return the 3 nearest (excluding exact if found)
  const sorted = all
    .filter((p) => p !== exact)
    .sort(
      (a, b) =>
        Math.abs(parseFloat(a.price) - targetPrice) - Math.abs(parseFloat(b.price) - targetPrice),
    );

  return { exact, nearest: sorted.slice(0, 3) };
}

/**
 * Set the price for a subscription using a resolved price point ID.
 */
export async function setSubscriptionPrice(
  config: AppleConnectConfig,
  subscriptionId: string,
  pricePointId: string,
): Promise<void> {
  await appleRequest(config, 'POST', '/subscriptionPrices', {
    data: {
      type: 'subscriptionPrices',
      attributes: {
        preserveCurrentPrice: false,
        startDate: null,
      },
      relationships: {
        subscription: {
          data: { type: 'subscriptions', id: subscriptionId },
        },
        subscriptionPricePoint: {
          data: { type: 'subscriptionPricePoints', id: pricePointId },
        },
      },
    },
  });
}

/**
 * Add a localized display name and description for a subscription.
 * Common locale values: "en-US", "ko", "ja", "zh-Hans"
 */
export async function addLocalization(
  config: AppleConnectConfig,
  subscriptionId: string,
  locale: string,
  name: string,
  description: string,
): Promise<void> {
  await appleRequest(config, 'POST', '/subscriptionLocalizations', {
    data: {
      type: 'subscriptionLocalizations',
      attributes: {
        locale,
        name,
        description,
      },
      relationships: {
        subscription: {
          data: { type: 'subscriptions', id: subscriptionId },
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map a period string from the tool layer to the App Store Connect enum value.
 */
function toSubscriptionPeriod(period: string): string {
  if (period === 'yearly') return 'ONE_YEAR';
  if (period === 'ONE_YEAR') return 'ONE_YEAR';
  if (period === 'ONE_MONTH') return 'ONE_MONTH';
  return 'ONE_MONTH'; // default to monthly
}

/**
 * Produce an actionable error message from raw Apple API errors.
 */
function translateAppleError(
  errors: AppleApiError[],
  httpStatus: number,
  productId: string,
): { message: string; errorType: CreateAppleSubscriptionResult['errorType'] } {
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      message:
        'API key is invalid or expired. Check keyId, issuerId, and privateKey in App Store Connect → Users and Access → Keys.',
      errorType: 'AUTH',
    };
  }

  for (const e of errors) {
    if (e.code === 'ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE') {
      return {
        message:
          `Product ID '${productId}' already exists in App Store Connect. ` +
          `Use \`onesub_list_products\` to see existing products, or choose a different product ID.`,
        errorType: 'DUPLICATE',
      };
    }

    if (e.code === 'ENTITY_ERROR.RELATIONSHIP.INVALID') {
      const pointer = e.source?.pointer ?? '';
      let hint = '';
      if (pointer.includes('app')) {
        hint = ' The App ID does not exist or your API key does not have access to it.';
      } else if (pointer.includes('group')) {
        hint = ' The subscription group ID is invalid. This is an internal error — please retry.';
      }
      return {
        message: `Relationship error: ${e.detail ?? e.title}.${hint}`,
        errorType: 'RELATIONSHIP',
      };
    }
  }

  const raw = errors.map((e) => `${e.code}: ${e.detail ?? e.title}`).join('; ');
  return {
    message: raw || `HTTP ${httpStatus}`,
    errorType: 'UNKNOWN',
  };
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Create a subscription group and a subscription product on App Store Connect.
 *
 * Accepts either `appId` (numeric) or `bundleId` — if only `bundleId` is given,
 * the numeric App ID is resolved automatically.
 *
 * After creating the subscription, attempts to:
 *  1. Find a matching price point for the given territory and set the price.
 *  2. Add a localized display name (Korean locale for KRW currency).
 */
export async function createAppleSubscription(opts: {
  productId: string;
  name: string;
  price: number;
  currency: string;
  period: string;
  keyId: string;
  issuerId: string;
  privateKey: string;
  appId?: string;
  bundleId?: string;
}): Promise<CreateAppleSubscriptionResult> {
  const config: AppleConnectConfig = {
    keyId: opts.keyId,
    issuerId: opts.issuerId,
    privateKey: opts.privateKey,
  };

  try {
    // Resolve appId — prefer explicit, fall back to bundleId lookup
    let appId = opts.appId;
    if (!appId) {
      if (!opts.bundleId) {
        return {
          success: false,
          error: 'Either appId or bundleId must be provided.',
          errorType: 'UNKNOWN',
        };
      }
      const resolved = await resolveAppId(config, opts.bundleId);
      if (!resolved) {
        return {
          success: false,
          error: `Could not resolve App ID for bundle ID '${opts.bundleId}'. Verify the bundle ID matches exactly what is registered in App Store Connect.`,
          errorType: 'UNKNOWN',
        };
      }
      appId = resolved;
    }

    // Step 1 — create subscription group
    let groupId: string;
    try {
      const groupResponse = await appleRequest<AppleSubscriptionGroupResponse>(
        config,
        'POST',
        '/subscriptionGroups',
        {
          data: {
            type: 'subscriptionGroups',
            attributes: {
              referenceName: `${opts.name} Group`,
            },
            relationships: {
              app: {
                data: { type: 'apps', id: appId },
              },
            },
          },
        },
      );
      groupId = groupResponse.data.id;
    } catch (err: unknown) {
      const appleErr = err as Error & { appleErrors?: AppleApiError[]; httpStatus?: number };
      const { message, errorType } = translateAppleError(
        appleErr.appleErrors ?? [],
        appleErr.httpStatus ?? 0,
        opts.productId,
      );
      return { success: false, error: message, errorType };
    }

    // Step 2 — create subscription inside the group
    let subscriptionId: string;
    try {
      const subResponse = await appleRequest<AppleSubscriptionResponse>(
        config,
        'POST',
        '/subscriptions',
        {
          data: {
            type: 'subscriptions',
            attributes: {
              name: opts.name,
              productId: opts.productId,
              subscriptionPeriod: toSubscriptionPeriod(opts.period),
              reviewNote: '',
            },
            relationships: {
              group: {
                data: { type: 'subscriptionGroups', id: groupId },
              },
            },
          },
        },
      );
      subscriptionId = subResponse.data.id;
    } catch (err: unknown) {
      const appleErr = err as Error & { appleErrors?: AppleApiError[]; httpStatus?: number };
      const { message, errorType } = translateAppleError(
        appleErr.appleErrors ?? [],
        appleErr.httpStatus ?? 0,
        opts.productId,
      );
      return { success: false, error: message, errorType };
    }

    // Step 3 — attempt to set price automatically
    // Map currency code to Apple territory code
    const territory = currencyToTerritory(opts.currency);
    let priceSet = false;
    let priceNearest: PricePointMatch[] | undefined;

    if (territory) {
      try {
        const priceResult = await findPricePoint(
          config,
          subscriptionId,
          territory,
          opts.price,
        );

        if (priceResult.exact) {
          await setSubscriptionPrice(config, subscriptionId, priceResult.exact.id);
          priceSet = true;
        } else {
          // Exact price tier not found — surface nearest options
          priceNearest = priceResult.nearest;
        }
      } catch {
        // Price setting is best-effort — subscription was still created
      }
    }

    // Step 4 — add Korean localization for KRW products
    let localizationAdded = false;
    if (opts.currency === 'KRW') {
      try {
        await addLocalization(config, subscriptionId, 'ko', opts.name, opts.name);
        localizationAdded = true;
      } catch {
        // Non-fatal
      }
    }

    return {
      success: true,
      productId: opts.productId,
      subscriptionId,
      priceSet,
      priceNearest,
      localizationAdded,
    };
  } catch (err: unknown) {
    const appleErr = err as Error & { appleErrors?: AppleApiError[]; httpStatus?: number };
    if (appleErr.appleErrors) {
      const { message, errorType } = translateAppleError(
        appleErr.appleErrors,
        appleErr.httpStatus ?? 0,
        opts.productId,
      );
      return { success: false, error: message, errorType };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      errorType: 'UNKNOWN',
    };
  }
}

/**
 * List in-app purchases (including subscriptions) for an app on App Store Connect.
 *
 * The tool layer calls this with: { keyId, issuerId, privateKey, appId }.
 */
export async function listAppleProducts(opts: {
  keyId: string;
  issuerId: string;
  privateKey: string;
  appId: string;
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
  const config: AppleConnectConfig = {
    keyId: opts.keyId,
    issuerId: opts.issuerId,
    privateKey: opts.privateKey,
  };

  const results: Array<{
    productId: string;
    name?: string;
    status?: string;
    type?: string;
  }> = [];

  // Fetch in-app purchases (non-subscription)
  try {
    const iapResp = await appleRequest<AppleInAppPurchaseListResponse>(
      config,
      'GET',
      `/apps/${encodeURIComponent(opts.appId)}/inAppPurchasesV2`,
    );

    for (const item of iapResp.data ?? []) {
      const attrs = item.attributes;
      results.push({
        productId: attrs.productId ?? item.id,
        name: attrs.name ?? attrs.referenceName,
        status: attrs.state,
        type: attrs.inAppPurchaseType ?? 'IN_APP_PURCHASE',
      });
    }
  } catch {
    // Non-fatal — app may have no non-subscription in-app purchases
  }

  // Fetch subscription groups + subscriptions
  try {
    const groupsResp = await appleRequest<AppleSubscriptionGroupListResponse>(
      config,
      'GET',
      `/apps/${encodeURIComponent(opts.appId)}/subscriptionGroups?include=subscriptions`,
    );

    // `included` contains the subscription objects when include=subscriptions is used
    for (const item of groupsResp.included ?? []) {
      if (item.type !== 'subscriptions') continue;
      const attrs = item.attributes;
      results.push({
        productId: attrs.productId ?? item.id,
        name: attrs.name,
        status: attrs.state,
        type: 'AUTO_RENEWABLE_SUBSCRIPTION',
      });
    }
  } catch {
    // Non-fatal — app may have no subscription products yet
  }

  return results;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Map an ISO 4217 currency code to the Apple territory code used in price point filters.
 * Returns undefined for currencies/territories not handled here.
 */
function currencyToTerritory(currency: string): string | undefined {
  const map: Record<string, string> = {
    KRW: 'KOR',
    USD: 'USA',
    EUR: 'EUR', // Apple uses 'EUR' as a territory placeholder for the euro zone
    JPY: 'JPN',
    GBP: 'GBR',
    AUD: 'AUS',
    CAD: 'CAN',
    CNY: 'CHN',
    SGD: 'SGP',
  };
  return map[currency.toUpperCase()];
}
