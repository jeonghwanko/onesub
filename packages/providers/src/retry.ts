/**
 * Bounded retry policy for store API rate limits.
 *
 * App Store Connect enforces hourly rate limits and bulk operations (e.g.
 * multi-region price setting, which paginates the full price-point list per
 * region) can trip them; Google Play has comparable quotas. HTTP 429 (and
 * transient 503) responses are worth a couple of bounded retries before the
 * error is surfaced to the caller unchanged.
 */

/** Statuses worth a bounded retry — rate limit and transient unavailability. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/** Retries after the initial attempt (worst case: 3 requests total). */
export const MAX_RETRIES = 2;

/** Exponential backoff when the server sends no usable Retry-After header. */
const BACKOFF_MS = [1_000, 4_000];

/** Cap server-provided Retry-After so total added latency stays bounded. */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Delay before retry `attempt` (0-based). Honors a numeric Retry-After header
 * (seconds, capped at 30s); otherwise falls back to exponential backoff.
 */
export function retryDelayMs(attempt: number, retryAfterHeader: string | null | undefined): number {
  if (retryAfterHeader != null) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
    }
  }
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
}

/**
 * Injectable sleep — request helpers call `backoff.sleep(ms)` so tests can
 * `vi.spyOn(backoff, 'sleep')` and assert wait durations without real timers.
 */
export const backoff = {
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};
