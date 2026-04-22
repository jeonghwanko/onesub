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
