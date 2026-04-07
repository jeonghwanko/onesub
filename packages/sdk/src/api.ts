import type {
  StatusResponse,
  ValidateReceiptRequest,
  ValidateReceiptResponse,
  ValidatePurchaseRequest,
  ValidatePurchaseResponse,
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
