import type { OneSubConfig, OneSubLogger } from '@onesub/shared';

/**
 * Logger used throughout the SDK. Wraps the host-provided `config.logger`
 * (or `console` if omitted) and adds a `trace` level that's a no-op unless
 * `config.debug === true`. Every call is tagged with `[onesub]` so host-app
 * logs stay greppable.
 *
 * `trace` is intended for lifecycle breadcrumbs (IAP connection, listener
 * events, in-flight matches, validation requests/responses, finishTransaction
 * calls). `info` / `warn` / `error` are production-safe.
 */
export interface SdkLogger {
  trace(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const TAG = '[onesub]';

const NOOP = (): void => {};

export function createSdkLogger(config: Pick<OneSubConfig, 'debug' | 'logger'>): SdkLogger {
  const sink: OneSubLogger = config.logger ?? console;
  const debug = config.debug === true;
  return {
    trace: debug ? (...args: unknown[]) => sink.info(TAG, ...args) : NOOP,
    info: (...args: unknown[]) => sink.info(TAG, ...args),
    warn: (...args: unknown[]) => sink.warn(TAG, ...args),
    error: (...args: unknown[]) => sink.error(TAG, ...args),
  };
}
