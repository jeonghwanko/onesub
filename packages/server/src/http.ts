/**
 * Outbound HTTP helpers shared by Apple/Google providers.
 *
 * Why timeouts: Node's global fetch has no default timeout. If the upstream
 * (Apple App Store Server API, Google Play Developer API, Google OAuth) hangs,
 * webhook handlers and validate routes hang with it — Apple/Google retry on
 * their side, so a hung outbound call cascades into request pile-up here.
 */

/** Default timeout for outbound API calls (10s). */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * fetch with an `AbortController`-based timeout. Throws an `AbortError`-like
 * Error when the timer fires. Caller is expected to catch and decide
 * (return null, log, propagate as 5xx, etc.).
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  // Allow caller-provided signal to compose with our timeout.
  const callerSignal = init?.signal;
  let onCallerAbort: (() => void) | undefined;
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else {
      onCallerAbort = () => controller.abort(callerSignal.reason);
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    controller.abort(new Error(`[onesub] fetch timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    // `{ once: true }` only self-removes when the event FIRES. On the normal
    // path it never does, so a caller that reuses one long-lived signal across
    // many requests would accumulate a listener per call on it — a slow leak
    // that surfaces as MaxListenersExceededWarning.
    if (onCallerAbort) callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}
