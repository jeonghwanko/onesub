import type { OneSubErrorCode } from '@onesub/shared';
import { ONESUB_ERROR_CODE } from '@onesub/shared';

// O(1) membership test over the enum. Module-level so it's allocated once,
// not per error path.
const KNOWN_CODES: ReadonlySet<string> = new Set(Object.values(ONESUB_ERROR_CODE));

/** Type guard for a string being a canonical `OneSubErrorCode`. */
export function isOneSubErrorCode(x: unknown): x is OneSubErrorCode {
  return typeof x === 'string' && KNOWN_CODES.has(x);
}

/**
 * Structured error thrown by the SDK. Consumers branch on `.code`
 * (a value from `ONESUB_ERROR_CODE`) for programmatic handling.
 */
export class OneSubError extends Error {
  readonly code: OneSubErrorCode;

  constructor(code: OneSubErrorCode, message?: string, cause?: unknown) {
    // ES2022 `cause` on the built-in Error — surfaces in DevTools cause chain
    // and `util.inspect` for free.
    super(message ?? code, cause !== undefined ? { cause } : undefined);
    this.name = 'OneSubError';
    this.code = code;
    // TS down-levels Error subclass inheritance; without this, `instanceof`
    // can misbehave on older targets.
    Object.setPrototypeOf(this, OneSubError.prototype);
  }
}

export function isOneSubError(err: unknown): err is OneSubError {
  return err instanceof OneSubError;
}

/**
 * Wrap any thrown value into a `OneSubError`. Values that already carry a
 * canonical `.code` are preserved; everything else falls back to
 * `INTERNAL_ERROR` (or the provided default).
 */
export function toOneSubError(err: unknown, fallbackCode: OneSubErrorCode = ONESUB_ERROR_CODE.INTERNAL_ERROR): OneSubError {
  if (err instanceof OneSubError) return err;
  if (err && typeof err === 'object') {
    const obj = err as { code?: unknown; message?: unknown };
    const code = isOneSubErrorCode(obj.code) ? obj.code : fallbackCode;
    const message = typeof obj.message === 'string' ? obj.message : undefined;
    return new OneSubError(code, message, err);
  }
  return new OneSubError(fallbackCode, String(err), err);
}
