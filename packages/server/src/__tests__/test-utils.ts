/**
 * Shared test helpers — kept here so unit tests don't reinvent the wheel
 * (and don't trip CodeQL with substring URL matching, which is unsafe in
 * production code and inconsistent across files).
 */

/**
 * Extract the hostname from a fetch input (string | URL | Request).
 * Returns null when the input isn't a parseable absolute URL.
 *
 * Use this instead of `urlStr.includes('host.com')` — substring matching
 * matches `https://attacker.example/?q=host.com` too, which CodeQL flags.
 */
export function urlHost(input: unknown): string | null {
  try {
    return new URL(String(input)).hostname;
  } catch {
    return null;
  }
}

/**
 * True for fetch URLs targeting the in-process test HTTP server. Used by
 * fetch mocks that need to pass-through the test runner's own requests
 * while intercepting outbound API calls.
 */
export function isLocalhostUrl(input: unknown): boolean {
  const host = urlHost(input);
  return host === '127.0.0.1' || host === 'localhost';
}
