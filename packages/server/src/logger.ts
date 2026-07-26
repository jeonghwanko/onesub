import type { OneSubLogger } from '@onesub/shared';
import { formatLogArgs } from './log-format.js';

/**
 * Process-wide logger used by @onesub/server's providers and routes.
 *
 * Defaults to `console`. `createOneSubMiddleware()` calls `setLogger()` once
 * during setup if `config.logger` is provided. All internal call sites should
 * import `log` from this module instead of calling `console.*` directly so
 * operators can redirect logs (pino / winston / bunyan) with a single config
 * setting.
 *
 * **The sink always receives exactly one string argument.** Rendering happens here,
 * in `log-format.ts`, rather than being left to whatever the host configured — and
 * that is the load-bearing decision, not an implementation detail:
 *
 *   - It is what makes the anti-forgery guarantee hold on every sink. Passing values
 *     as a trailing object works on `console`, because `util.inspect` escapes
 *     strings inside objects — but `pino`, which this package's own docs recommend,
 *     treats a trailing object as a printf interpolation argument. Leaving the
 *     escaping to the sink means it only happens for some of them.
 *   - It fixes a bug nobody would have noticed until it mattered: `Error` properties
 *     are non-enumerable, so a JSON-serialising sink turns `{ err }` into `{}` and
 *     loses the error entirely.
 *
 * The cost is that structured fields arrive as `key=value` text inside the message
 * rather than as typed JSON fields. That is a deferral, not the end state — a typed
 * `structuredLogger` sink is a cheap follow-on now that the call sites carry
 * `(message, fields)`. It is also already better than what a pino host got before,
 * which was printf varargs flattened into the message with no field names at all.
 */

let current: OneSubLogger = console;

export function setLogger(logger: OneSubLogger | undefined): void {
  if (logger) current = logger;
}

export const log: OneSubLogger = {
  info: (...args) => current.info(formatLogArgs(args)),
  warn: (...args) => current.warn(formatLogArgs(args)),
  error: (...args) => current.error(formatLogArgs(args)),
};
