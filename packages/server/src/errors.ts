import type { Response } from 'express';
import { z } from 'zod';
import type { OneSubErrorCode } from '@onesub/shared';
import { ONESUB_ERROR_CODE } from '@onesub/shared';

/**
 * Send a structured error response. Every onesub HTTP endpoint uses this
 * so consumers can rely on `errorCode` being present on every 4xx/5xx body.
 *
 * `extra` lets callers inject route-specific defaults (e.g. `purchase: null`
 * for ValidatePurchaseResponse shape compatibility).
 */
export function sendError(
  res: Response,
  status: number,
  code: OneSubErrorCode,
  error: string,
  extra: Record<string, unknown> = {},
): void {
  res.status(status).json({ ...extra, error, errorCode: code });
}

/**
 * 400 response for a failed zod parse. The ZodError's per-issue messages
 * are joined for the human-readable `error` field.
 */
export function sendZodError(
  res: Response,
  err: z.ZodError,
  extra: Record<string, unknown> = {},
): void {
  sendError(
    res,
    400,
    ONESUB_ERROR_CODE.INVALID_INPUT,
    err.issues.map((e: { message: string }) => e.message).join(', '),
    extra,
  );
}

export interface ParseOrSendOptions {
  /**
   * Route-specific fields to merge into the error body, so a 400 keeps the
   * shape the route's success response has (`subscription: null`,
   * `purchases: []`, and so on).
   */
  extra?: Record<string, unknown>;
  /**
   * Send this one message instead of the per-issue zod detail. Use it where the
   * route deliberately does not echo the input shape back — URL params, and the
   * entitlement routes. Omit it to get the field-level detail.
   */
  message?: string;
}

/**
 * Parse `input` with `schema`, or send a 400 and return `undefined`.
 *
 * ```ts
 * const body = parseOrSend(res, validateSchema, req.body, { extra: NO_SUB });
 * if (!body) return;
 * ```
 *
 * Every route was hand-rolling this, and in three different shapes: a
 * `try/catch` that re-threw non-zod errors, a `try/catch {}` that swallowed
 * everything into one generic message, and `safeParse`. The first is correct but
 * five lines per call site; the second silently turns a genuine bug inside the
 * schema — a bad refinement, a throwing transform — into "400 bad input", which
 * is the wrong status and hides the cause.
 *
 * This keeps the correct behaviour and makes it the short one: zod failures
 * become a 400, and anything else propagates to the route's own error handling
 * rather than being reported as the caller's fault.
 */
export function parseOrSend<S extends z.ZodType>(
  res: Response,
  schema: S,
  input: unknown,
  opts: ParseOrSendOptions = {},
): z.output<S> | undefined {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  if (opts.message !== undefined) {
    sendError(res, 400, ONESUB_ERROR_CODE.INVALID_INPUT, opts.message, opts.extra ?? {});
  } else {
    sendZodError(res, result.error, opts.extra ?? {});
  }
  return undefined;
}
