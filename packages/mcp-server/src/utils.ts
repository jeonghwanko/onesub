/** Shared HTTP utilities for MCP tool implementations. */

export const MCP_FETCH_TIMEOUT_MS = 10_000;

export const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

/** Strip trailing slash so `${base}${ROUTE}` never produces double-slashes. */
export function normalizeUrl(url: string): string {
  return url.replace(/\/$/, '');
}

export type FetchJsonResult<T = unknown> =
  | { ok: true; httpStatus: number; data: T }
  | { ok: false; httpStatus: number; error: string; raw?: string };

/**
 * Fetch a URL, parse the JSON body, and return a discriminated-union result.
 * Never throws — network errors and JSON parse failures are returned as `ok: false`.
 *
 * Default behaviour: GET with Content-Type application/json and a 10-second timeout.
 * Override any of these via `options`.
 */
export async function fetchJson<T = unknown>(
  url: string,
  options?: RequestInit,
): Promise<FetchJsonResult<T>> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(MCP_FETCH_TIMEOUT_MS),
      ...options,
      // Merge headers so callers can add Authorization etc. without losing Content-Type.
      headers: { ...JSON_HEADERS, ...(options?.headers as Record<string, string> | undefined) },
    });
    const raw = await res.text();
    if (!res.ok) {
      return { ok: false, httpStatus: res.status, error: `HTTP ${res.status}`, raw };
    }
    try {
      return { ok: true, httpStatus: res.status, data: JSON.parse(raw) as T };
    } catch {
      return { ok: false, httpStatus: res.status, error: 'invalid JSON', raw };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, httpStatus: 0, error: msg };
  }
}
