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
  // One literal replacement per character rather than a single regex with a
  // callback. This was changed hoping CodeQL's js/log-injection sanitiser
  // recognition would follow it; it did not, and the alert points at the spread in
  // `log.*` rather than here. The form is kept because it reads more plainly, not
  // because it satisfies an analyser.
  return value
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Applied to top-level string arguments only. Objects and `Error`s pass through
 * untouched, which is a real and deliberate gap rather than an oversight: an
 * `Error` reaching `log.error('...:', err)` can carry attacker-influenced text in
 * its message, so a newline there can still break a line.
 *
 * It is left that way because the alternative is worse. A stack trace is multi-line
 * by nature and is the main reason to log an `Error` at all; escaping its newlines
 * would turn every trace into one unreadable line, and escaping only `message`
 * achieves nothing because `stack` repeats it. Recursively rewriting strings inside
 * objects would likewise corrupt structured fields an operator asked to see.
 *
 * So the guarantee is scoped: message strings this server composes cannot be used
 * to forge a line. Reading a trace still requires distinguishing it from
 * surrounding entries by context, as it always has. CodeQL reports this gap on the
 * spread in `log.*` and is correct to; the alert is dismissed as won't-fix with
 * this reasoning, not as a false positive.
 */
function scrub(args: unknown[]): unknown[] {
  return args.map((arg) => (typeof arg === 'string' ? escapeLineBreaks(arg) : arg));
}

export const log: OneSubLogger = {
  info: (...args) => current.info(...scrub(args)),
  warn: (...args) => current.warn(...scrub(args)),
  error: (...args) => current.error(...scrub(args)),
};
