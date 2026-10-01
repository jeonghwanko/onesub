import type { ErrorRequestHandler, Response } from 'express';
import { z } from 'zod';
import type { OneSubErrorCode } from '@onesub/shared';
import { ONESUB_ERROR_CODE } from '@onesub/shared';
import { log } from './logger.js';

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

/**
 * True for the ownership-conflict error every PurchaseStore throws from
 * `savePurchase` when the transactionId is already recorded for another user —
 * including when a concurrent request won the race to claim it.
 */
export function isOwnershipConflict(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === ONESUB_ERROR_CODE.TRANSACTION_BELONGS_TO_OTHER_USER;
}

/**
 * True for the conflict a PurchaseStore throws when the user already holds this
 * non-consumable under a different transactionId (see `purchaseConflict`).
 */
export function isNonConsumableOwnedConflict(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === ONESUB_ERROR_CODE.NON_CONSUMABLE_ALREADY_OWNED;
}

/**
 * Last-resort handler for the onesub router, so an error that escapes a route
 * still answers with the `{ error, errorCode }` body every client parses —
 * not Express's HTML page, and not a hung request.
 *
 * Scoped to `/onesub/*`: the router's JSON parser runs for every request that
 * passes through it, and a host's own routes must keep reaching the host's
 * error handler.
 */
export const oneSubErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Express matches routes case-insensitively, so must this.
  if (res.headersSent || !req.path.toLowerCase().startsWith('/onesub/')) {
    next(err);
    return;
  }
  const { type, status } = (err ?? {}) as { type?: unknown; status?: unknown };
  if (type === 'entity.parse.failed') {
    sendError(res, 400, ONESUB_ERROR_CODE.INVALID_INPUT, 'Malformed JSON body');
    return;
  }
  if (type === 'entity.too.large') {
    sendError(res, 413, ONESUB_ERROR_CODE.INVALID_INPUT, 'Request body too large');
    return;
  }
  // Any other body-parser rejection (unsupported charset/encoding, an aborted
  // upload) is the client's: keep its 4xx rather than reporting a server error.
  if (typeof type === 'string' && typeof status === 'number' && status >= 400 && status < 500) {
    sendError(res, status, ONESUB_ERROR_CODE.INVALID_INPUT, 'Unreadable request body');
    return;
  }
  log.error('[onesub] Unhandled route error', { route: req.path, err });
  sendError(res, 500, ONESUB_ERROR_CODE.INTERNAL_ERROR, 'Internal server error');
};
