import type {
  StatusResponse,
  ValidateReceiptRequest,
  ValidateReceiptResponse,
  ValidatePurchaseRequest,
  ValidatePurchaseResponse,
  PurchaseStatusResponse,
  EntitlementResponse,
  EntitlementsResponse,
} from '@onesub/shared';
import { ROUTES } from '@onesub/shared';

/**
 * Checks the subscription status for a given user from the onesub server.
 */
export async function checkStatus(
  serverUrl: string,
  userId: string,
): Promise<StatusResponse> {
  const url = `${serverUrl.replace(/\/$/, '')}${ROUTES.STATUS}?userId=${encodeURIComponent(userId)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`[onesub] Status check failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as StatusResponse;
  return data;
}

/**
 * Validates a subscription receipt with the onesub server.
 * The server handles Apple/Google verification and stores the subscription.
 */
export async function validateReceipt(
  serverUrl: string,
  receipt: ValidateReceiptRequest,
): Promise<ValidateReceiptResponse> {
  const url = `${serverUrl.replace(/\/$/, '')}${ROUTES.VALIDATE}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(receipt),
  });

  if (!response.ok) {
    throw new Error(`[onesub] Receipt validation failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as ValidateReceiptResponse;
  return data;
}

/**
 * Validates a consumable or non-consumable product purchase with the onesub server.
 * The server verifies the Apple/Google receipt and records the purchase.
 */
export async function validatePurchase(
  serverUrl: string,
  request: ValidatePurchaseRequest,
): Promise<ValidatePurchaseResponse> {
  const url = `${serverUrl.replace(/\/$/, '')}${ROUTES.VALIDATE_PURCHASE}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`[onesub] Purchase validation failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as ValidatePurchaseResponse;
  return data;
}

/**
 * Checks the purchase status for a given user from the onesub server.
 * Optionally filter by productId.
 */
export async function checkPurchaseStatus(
  serverUrl: string,
  userId: string,
  productId?: string,
): Promise<PurchaseStatusResponse> {
  let url = `${serverUrl.replace(/\/$/, '')}${ROUTES.PURCHASE_STATUS}?userId=${encodeURIComponent(userId)}`;
  if (productId) {
    url += `&productId=${encodeURIComponent(productId)}`;
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`[onesub] Purchase status check failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as PurchaseStatusResponse;
  return data;
}

/**
 * Check a single entitlement for a user. Returns `{ active: false, source: null }`
 * when the user has no matching record, or throws on transport / server error.
 *
 * Returns 404 errorCode `ENTITLEMENT_NOT_FOUND` when the id is unknown to the
 * server (config mismatch). The throw differentiates this from "user not entitled".
 */
export async function checkEntitlement(
  serverUrl: string,
  userId: string,
  id: string,
): Promise<EntitlementResponse> {
  const url =
    `${serverUrl.replace(/\/$/, '')}${ROUTES.ENTITLEMENT}` +
    `?userId=${encodeURIComponent(userId)}&id=${encodeURIComponent(id)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`[onesub] Entitlement check failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as EntitlementResponse;
}

/**
 * Check all entitlements configured on the server in one round-trip.
 * Use on app launch / login to populate the entitlements map.
 *
 * Returns `{ entitlements: {} }` when the server has no entitlements
 * configured (the route is not mounted, returning 404 — surfaced here as an
 * empty map rather than a throw, since "no entitlements configured" is a
 * valid runtime state, not an error).
 */
export async function checkEntitlements(
  serverUrl: string,
  userId: string,
): Promise<EntitlementsResponse> {
  const url =
    `${serverUrl.replace(/\/$/, '')}${ROUTES.ENTITLEMENTS}` +
    `?userId=${encodeURIComponent(userId)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (response.status === 404) {
    // Route not mounted — server has no entitlements configured. Empty map is
    // the right state-of-the-world here.
    return { entitlements: {} };
  }
  if (!response.ok) {
    throw new Error(`[onesub] Entitlements bulk check failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as EntitlementsResponse;
}
