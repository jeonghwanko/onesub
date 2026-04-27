/**
 * Server-side fetch helpers for the onesub server's admin metrics API.
 *
 * Always called from server components / server actions / route handlers — the
 * admin secret never leaves the server. The dashboard's HTTP-only cookie
 * stores the secret directly (acceptable for v0.1; a token-exchange layer is
 * Phase 3 work).
 */

import type {
  CustomerProfileResponse,
  ListSubscriptionsQuery,
  ListSubscriptionsResponse,
  MetricsActiveResponse,
  MetricsCountResponse,
  MetricsGroupBy,
  SubscriptionInfo,
} from '@onesub/shared';

export interface MetricsRangeOptions {
  /** When set, response includes a daily `buckets` array (zero-filled). */
  groupBy?: MetricsGroupBy;
}

export interface OneSubClient {
  getActiveMetrics(): Promise<MetricsActiveResponse>;
  getStartedMetrics(from: Date, to: Date, opts?: MetricsRangeOptions): Promise<MetricsCountResponse>;
  getExpiredMetrics(from: Date, to: Date, opts?: MetricsRangeOptions): Promise<MetricsCountResponse>;
  /**
   * Non-consumable purchases started in the window. Use for the dashboard's
   * Purchases timeseries — equivalent to getStartedMetrics but counts
   * lifetime products instead of subscriptions.
   */
  getPurchasesStartedMetrics(from: Date, to: Date, opts?: MetricsRangeOptions): Promise<MetricsCountResponse>;
  listSubscriptions(query: ListSubscriptionsQuery): Promise<ListSubscriptionsResponse>;
  /**
   * Fetch a single subscription record by `originalTransactionId`. Throws
   * `OneSubFetchError` with `status: 404` when the id is unknown — callers
   * should branch on that to render a "not found" page.
   */
  getSubscription(transactionId: string): Promise<SubscriptionInfo>;
  /**
   * Fetch the full per-user profile (subs + purchases + entitlements when
   * configured). Always 200 — unknown userIds return empty arrays.
   */
  getCustomer(userId: string): Promise<CustomerProfileResponse>;
}

export class OneSubFetchError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OneSubFetchError';
  }
}

export function createClient(serverUrl: string, adminSecret: string): OneSubClient {
  const base = serverUrl.replace(/\/$/, '');
  const headers = { 'X-Admin-Secret': adminSecret, 'Content-Type': 'application/json' };

  async function get<T>(path: string): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      headers,
      // Dashboard pages are server-rendered per request — opt out of Next.js
      // fetch caching so admins see fresh state on every refresh.
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new OneSubFetchError(response.status, `${path} → ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  }

  function rangePath(base: string, from: Date, to: Date, opts?: MetricsRangeOptions): string {
    const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    if (opts?.groupBy) params.set('groupBy', opts.groupBy);
    return `${base}?${params.toString()}`;
  }

  return {
    getActiveMetrics: () => get<MetricsActiveResponse>('/onesub/metrics/active'),
    getStartedMetrics: (from, to, opts) =>
      get<MetricsCountResponse>(rangePath('/onesub/metrics/started', from, to, opts)),
    getExpiredMetrics: (from, to, opts) =>
      get<MetricsCountResponse>(rangePath('/onesub/metrics/expired', from, to, opts)),
    getPurchasesStartedMetrics: (from, to, opts) =>
      get<MetricsCountResponse>(rangePath('/onesub/metrics/purchases/started', from, to, opts)),
    listSubscriptions: (query) => {
      const params = new URLSearchParams();
      if (query.userId)    params.set('userId', query.userId);
      if (query.status)    params.set('status', query.status);
      if (query.productId) params.set('productId', query.productId);
      if (query.platform)  params.set('platform', query.platform);
      if (query.limit !== undefined)  params.set('limit', String(query.limit));
      if (query.offset !== undefined) params.set('offset', String(query.offset));
      const qs = params.toString();
      return get<ListSubscriptionsResponse>(`/onesub/admin/subscriptions${qs ? `?${qs}` : ''}`);
    },
    getSubscription: (transactionId) =>
      get<SubscriptionInfo>(`/onesub/admin/subscriptions/${encodeURIComponent(transactionId)}`),
    getCustomer: (userId) =>
      get<CustomerProfileResponse>(`/onesub/admin/customers/${encodeURIComponent(userId)}`),
  };
}
