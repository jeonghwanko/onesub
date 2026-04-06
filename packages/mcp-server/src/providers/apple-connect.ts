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
// Types
// ---------------------------------------------------------------------------

export interface AppleConnectConfig {
  keyId: string;
  issuerId: string;
  /** Contents of the .p8 private key file */
  privateKey: string;
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
  const url = `${BASE_URL}${path}`;

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
    const detail =
      errBody.errors?.map((e) => `${e.code}: ${e.detail ?? e.title}`).join('; ') ??
      `HTTP ${resp.status}`;
    throw new Error(`Apple API error — ${detail}`);
  }

  return json;
}

// ---------------------------------------------------------------------------
// Exported functions
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
 * Create a subscription group and a subscription product on App Store Connect.
 *
 * The tool layer calls this with: { productId, name, price, currency, period,
 * keyId, issuerId, privateKey, appId }.
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
  appId: string;
}): Promise<{ success: boolean; productId?: string; subscriptionId?: string; error?: string }> {
  const config: AppleConnectConfig = {
    keyId: opts.keyId,
    issuerId: opts.issuerId,
    privateKey: opts.privateKey,
  };

  try {
    // Step 1 — create subscription group
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
              data: { type: 'apps', id: opts.appId },
            },
          },
        },
      },
    );

    const groupId = groupResponse.data.id;

    // Step 2 — create subscription inside the group
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

    return {
      success: true,
      productId: opts.productId,
      subscriptionId: subResponse.data.id,
    };
  } catch (err: unknown) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
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
