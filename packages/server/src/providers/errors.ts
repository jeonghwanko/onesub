/**
 * The store's API could not give a verdict on a receipt: a 5xx, a 429, a
 * timeout, a network failure, or our own credentials being refused.
 *
 * Validators return `null` only for a receipt the store actually rejected.
 * Folding an outage into that `null` told clients "this receipt is invalid" —
 * an authoritative 422 they stop retrying on — for purchases that were fine.
 * Routes map this error to a retryable 503 `PROVIDER_UNAVAILABLE` instead.
 */
export class ProviderUnavailableError extends Error {
  readonly provider: 'apple' | 'google';

  constructor(provider: 'apple' | 'google', message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderUnavailableError';
    this.provider = provider;
  }
}
