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
import { ROUTES, ONESUB_ERROR_CODE } from '@onesub/shared';
import { OneSubError, isOneSubErrorCode } from './OneSubError.js';

/**
 * Upper bound for one round-trip to the onesub server, body included. Without
 * it a stalled connection hangs validation until the 180 s purchase timer
 * fires and reports PURCHASE_TIMEOUT — for a purchase that may well succeed.
 *
 * It must exceed the server's own worst case, or the client gives up on a
 * validation the server then completes: a Google validation makes two
 * sequential store calls of up to 10 s each, plus the store write, and a host
 * may make its own store calls before it (a pre-check) — so allow for double.
 */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * `fetch` + `read` under one deadline. A transport failure — offline, DNS, TLS,
 * the deadline — becomes `NETWORK_ERROR`, the code hosts already branch on to
 * show "check your connection" and retry.
 */
async function send<T>(
  url: string,
  init: RequestInit,
  what: string,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  // AbortController exists in React Native and every supported JS runtime;
  // the guard only keeps an exotic host without it working, unbounded.
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : undefined;
  try {
    let response: Response;
    try {
      response = await fetch(url, controller ? { ...init, signal: controller.signal } : init);
    } catch (err) {
      throw networkError(what, err, controller?.signal.aborted === true);
    }
    try {
      return await read(response);
    } catch (err) {
      if (controller?.signal.aborted) throw networkError(what, err, true);
      throw err;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function networkError(what: string, cause: unknown, timedOut: boolean): OneSubError {
  const detail = timedOut
    ? `timed out after ${REQUEST_TIMEOUT_MS} ms`
    : cause instanceof Error ? cause.message : String(cause);
  return new OneSubError(ONESUB_ERROR_CODE.NETWORK_ERROR, `[onesub] ${what}: ${detail}`, cause);
}

/**
 * The error for a non-2xx response. A onesub error body's own `errorCode` wins —
 * `ENTITLEMENT_NOT_FOUND`, `USER_ID_TOO_LONG`, `STORE_ERROR` mean something the
 * host can act on. Without one, 5xx / 429 / 408 come from the server's
 * infrastructure or an outage — transient, so NETWORK_ERROR — and anything else
 * is unexpected, so INTERNAL_ERROR.
 */
async function httpError(what: string, response: Response): Promise<OneSubError> {
  const message = `[onesub] ${what}: ${response.status} ${response.statusText}`;
  const body = await parseErrorBody<{ errorCode?: unknown }>(response);
  if (body && isOneSubErrorCode(body.errorCode)) return new OneSubError(body.errorCode, message);
  const transient = response.status >= 500 || response.status === 429 || response.status === 408;
  return new OneSubError(transient ? ONESUB_ERROR_CODE.NETWORK_ERROR : ONESUB_ERROR_CODE.INTERNAL_ERROR, message);
}

/**
 * The server signals validation failures as 4xx/5xx with a structured JSON
 * body (`{ valid: false, error, errorCode }`). Parse and return that body so
 * callers can branch on `errorCode`; return null when the body is missing,
 * not JSON, or JSON that doesn't have the onesub response shape (e.g. a
 * proxy 502/429 `{"message":"upstream timeout"}` — treating that as a
 * validation result would surface a permanent-looking failure for what is a
 * transient infra error; the caller must fall back to its generic throw).
 */
async function parseErrorBody<T>(response: Response): Promise<T | null> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object') {
      const b = body as { valid?: unknown; errorCode?: unknown };
      if (typeof b.valid === 'boolean' || typeof b.errorCode === 'string') {
        return body as T;
      }
    }
  } catch {
    // Not JSON — treat as transport-level failure.
  }
  return null;
}

/**
 * Checks the subscription status for a given user from the onesub server.
 */
export async function checkStatus(
  serverUrl: string,
  userId: string,
): Promise<StatusResponse> {
  const url = `${serverUrl.replace(/\/$/, '')}${ROUTES.STATUS}?userId=${encodeURIComponent(userId)}`;

  return send(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } }, 'Status check failed', async (response) => {
    if (!response.ok) throw await httpError('Status check failed', response);
    return (await response.json()) as StatusResponse;
  });
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

  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(receipt) };
  return send(url, init, 'Receipt validation failed', async (response) => {
    if (!response.ok) {
      const body = await parseErrorBody<ValidateReceiptResponse>(response);
      if (body) return body;
      throw await httpError('Receipt validation failed', response);
    }
    return (await response.json()) as ValidateReceiptResponse;
  });
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

  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) };
  return send(url, init, 'Purchase validation failed', async (response) => {
    if (!response.ok) {
      const body = await parseErrorBody<ValidatePurchaseResponse>(response);
      if (body) return body;
      throw await httpError('Purchase validation failed', response);
    }
    return (await response.json()) as ValidatePurchaseResponse;
  });
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

  return send(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } }, 'Purchase status check failed', async (response) => {
    if (!response.ok) throw await httpError('Purchase status check failed', response);
    return (await response.json()) as PurchaseStatusResponse;
  });
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

  return send(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } }, 'Entitlement check failed', async (response) => {
    if (!response.ok) throw await httpError('Entitlement check failed', response);
    return (await response.json()) as EntitlementResponse;
  });
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

  return send(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } }, 'Entitlements bulk check failed', async (response) => {
    if (response.status === 404) {
      // Route not mounted — server has no entitlements configured. Empty map is
      // the right state-of-the-world here.
      return { entitlements: {} };
    }
    if (!response.ok) throw await httpError('Entitlements bulk check failed', response);
    return (await response.json()) as EntitlementsResponse;
  });
}
