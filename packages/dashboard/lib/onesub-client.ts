/**
 * Server-side fetch helpers for the onesub server's admin metrics API.
 *
 * Always called from server components / server actions / route handlers — the
 * admin secret never leaves the server. The dashboard's HTTP-only cookie
 * stores the secret directly (acceptable for v0.1; a token-exchange layer is
 * Phase 3 work).
 */

import type { MetricsActiveResponse, MetricsCountResponse } from '@onesub/shared';

export interface OneSubClient {
  getActiveMetrics(): Promise<MetricsActiveResponse>;
  getStartedMetrics(from: Date, to: Date): Promise<MetricsCountResponse>;
  getExpiredMetrics(from: Date, to: Date): Promise<MetricsCountResponse>;
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

  return {
    getActiveMetrics: () => get<MetricsActiveResponse>('/onesub/metrics/active'),
    getStartedMetrics: (from, to) =>
      get<MetricsCountResponse>(
        `/onesub/metrics/started?from=${from.toISOString()}&to=${to.toISOString()}`,
      ),
    getExpiredMetrics: (from, to) =>
      get<MetricsCountResponse>(
        `/onesub/metrics/expired?from=${from.toISOString()}&to=${to.toISOString()}`,
      ),
  };
}
