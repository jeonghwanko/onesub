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

/**
 * Neutralise line breaks in a logged string.
 *
 * Much of what this server logs is attacker-influenced: `userId` comes off the
 * request body, and bundle ids, package names and receipt previews come out of
 * submitted receipts. A newline in any of those lets a caller close the current
 * log line and write a whole entry of their own — so a `userId` of
 * `alice\n[onesub] admin granted premium to mallory` forges an audit record.
 * These logs are what support and fraud decisions are read from, so the forgery
 * matters more than the noise.
 *
 * Escaped rather than stripped: the substitution has to be visible, or scrubbing
 * would quietly merge two lines into one plausible-looking line. Only the
 * characters that can end a log line are touched; tabs and everything else are
 * left alone.
 */
function escapeLineBreaks(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]/g, (ch) => {
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

/**
 * Applied to top-level string arguments only. Objects and `Error`s are passed
 * through untouched — a structured logger serialises those itself, and rewriting
 * them here would corrupt data the operator asked for. The line-forgery vector is
 * the message string, which is what this covers.
 */
function scrub(args: unknown[]): unknown[] {
  return args.map((arg) => (typeof arg === 'string' ? escapeLineBreaks(arg) : arg));
}

export const log: OneSubLogger = {
  info: (...args) => current.info(...scrub(args)),
  warn: (...args) => current.warn(...scrub(args)),
  error: (...args) => current.error(...scrub(args)),
};
