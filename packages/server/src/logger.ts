import type { OneSubLogger } from '@onesub/shared';

/**
 * Process-wide logger used by @onesub/server's providers and routes.
 *
 * Defaults to `console`. `createOneSubMiddleware()` calls `setLogger()` once
 * during setup if `config.logger` is provided. All internal call sites should
 * import `log` from this module instead of calling `console.*` directly so
 * operators can redirect logs (pino / winston / bunyan) with a single config
 * setting.
 */

let current: OneSubLogger = console;

export function setLogger(logger: OneSubLogger | undefined): void {
  if (logger) current = logger;
}

export const log: OneSubLogger = {
  info: (...args) => current.info(...args),
  warn: (...args) => current.warn(...args),
  error: (...args) => current.error(...args),
};
