'use server';

/**
 * Server actions for admin write operations on the customer detail page.
 *
 * All three call into `OneSubClient` (which carries the admin secret server-side
 * via the cookie) then `revalidatePath` so the UI re-renders with fresh data.
 * On 401 we clear the cookie + redirect — same fallback pattern as the read
 * pages have for stale sessions.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { Platform, PurchaseType } from '@onesub/shared';
import { clearAdminSecret, requireClient } from './auth';
import { OneSubFetchError } from './onesub-client';

export interface ActionResult {
  ok: boolean;
  /** Operator-friendly error message when ok is false. */
  error?: string;
}

async function withClient<T>(fn: (client: Awaited<ReturnType<typeof requireClient>>) => Promise<T>): Promise<T> {
  const client = await requireClient();
  try {
    return await fn(client);
  } catch (err) {
    if (err instanceof OneSubFetchError && err.status === 401) {
      await clearAdminSecret();
      redirect('/login');
    }
    throw err;
  }
}

function asString(v: FormDataEntryValue | null): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Grant — manually create a purchase row for `userId + productId`. Used for
 * goodwill grants, refund recovery, beta gifts. Skips the store's receipt
 * validation entirely; the operator is asserting entitlement.
 */
export async function grantPurchaseAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const userId = asString(formData.get('userId'));
  const productId = asString(formData.get('productId'));
  const platformRaw = asString(formData.get('platform'));
  const typeRaw = asString(formData.get('type'));
  const transactionId = asString(formData.get('transactionId')) ?? undefined;

  if (!userId || !productId) return { ok: false, error: 'userId / productId 누락' };
  if (platformRaw !== 'apple' && platformRaw !== 'google') {
    return { ok: false, error: 'platform은 apple/google 중 하나' };
  }
  // Default to non-consumable since that's the realistic CS use case (consumable
  // grants are usually a different code path — coin balances etc).
  const type: PurchaseType = typeRaw === 'consumable' ? 'consumable' : 'non_consumable';

  try {
    await withClient((client) =>
      client.grantPurchase({
        userId,
        productId,
        platform: platformRaw as Platform,
        type,
        transactionId,
      }),
    );
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? 'grant failed' };
  }

  revalidatePath(`/dashboard/customers/${userId}`);
  return { ok: true };
}

/**
 * Transfer — reassign a purchase's ownership to another userId. Server 404s if
 * the transactionId is unknown.
 */
export async function transferPurchaseAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const transactionId = asString(formData.get('transactionId'));
  const newUserId = asString(formData.get('newUserId'));
  const fromUserId = asString(formData.get('fromUserId'));  // for revalidation only

  if (!transactionId || !newUserId) return { ok: false, error: 'transactionId / newUserId 누락' };
  if (newUserId === fromUserId) return { ok: false, error: '같은 userId로의 transfer는 의미 없습니다' };

  try {
    await withClient((client) => client.transferPurchase(transactionId, newUserId));
  } catch (err) {
    if (err instanceof OneSubFetchError && err.status === 404) {
      return { ok: false, error: 'TRANSACTION_NOT_FOUND — 해당 transactionId가 존재하지 않습니다' };
    }
    return { ok: false, error: (err as Error).message ?? 'transfer failed' };
  }

  // The old userId's customer page no longer owns the row → refresh it.
  // We don't redirect to the new owner: the operator might want to verify the
  // old page is now empty before navigating.
  if (fromUserId) revalidatePath(`/dashboard/customers/${fromUserId}`);
  revalidatePath(`/dashboard/customers/${newUserId}`);
  return { ok: true };
}

/**
 * Delete — drop every purchase row matching `userId + productId`. Used for
 * non-consumable re-test / refund cleanup.
 */
export async function deletePurchasesAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const userId = asString(formData.get('userId'));
  const productId = asString(formData.get('productId'));

  if (!userId || !productId) return { ok: false, error: 'userId / productId 누락' };

  try {
    await withClient((client) => client.deletePurchases(userId, productId));
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? 'delete failed' };
  }

  revalidatePath(`/dashboard/customers/${userId}`);
  return { ok: true };
}
