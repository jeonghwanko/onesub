/**
 * OpenAPI 3.1 spec for the onesub HTTP surface.
 *
 * Hand-maintained — kept in sync with the routes by a parity test (see
 * __tests__/openapi.test.ts) that asserts every mounted path is described
 * here. Generated clients live downstream:
 *
 *   - swagger-typescript-api → typed fetch client
 *   - openapi-generator-cli  → Kotlin/Swift/etc. clients
 *
 * Why hand-maintained instead of zod-to-openapi: the routes use zod for
 * input validation but the request/response shapes the public docs need are
 * a thin slice of those internal types. Hand-writing keeps the doc readable
 * without coupling client output to internal validation strictness changes.
 */

import { ROUTES } from '@onesub/shared';

export interface OpenAPIDoc {
  openapi: '3.1.0';
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string; description?: string }>;
  paths: Record<string, unknown>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
}

export const ONESUB_OPENAPI: OpenAPIDoc = {
  openapi: '3.1.0',
  info: {
    title: 'onesub HTTP API',
    version: '1.0.0',
    description:
      'Receipt validation, subscription status, webhooks, and admin endpoints exposed by `createOneSubMiddleware`.',
  },
  servers: [
    { url: 'http://localhost:4100', description: 'Local dev (examples/server)' },
  ],
  paths: {
    [ROUTES.VALIDATE]: {
      post: {
        summary: 'Validate an Apple/Google receipt and persist subscription state.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidateRequest' } } },
        },
        responses: {
          200: { description: 'Validation succeeded; subscription state persisted.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidateResponse' } } } },
          400: { description: 'Bad request — missing fields, malformed receipt, package mismatch.' },
        },
      },
    },
    [ROUTES.STATUS]: {
      get: {
        summary: 'Fetch the most recent subscription state for a user.',
        parameters: [{ in: 'query', name: 'userId', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/StatusResponse' } } } },
        },
      },
    },
    [ROUTES.WEBHOOK_APPLE]: {
      post: {
        summary: 'Apple App Store Server Notification V2 receiver.',
        description:
          'Apple POSTs `{ signedPayload }`. JWS-verified, idempotent when `webhookEventStore` is configured.',
        responses: {
          200: { description: 'Acknowledged.' },
          400: { description: 'Missing or invalid signedPayload.' },
        },
      },
    },
    [ROUTES.WEBHOOK_GOOGLE]: {
      post: {
        summary: 'Google Play Real-Time Developer Notification (Pub/Sub push) receiver.',
        responses: {
          200: { description: 'Acknowledged.' },
          400: { description: 'Missing message.data or package mismatch.' },
          401: { description: 'pushAudience configured and JWT verification failed.' },
        },
      },
    },
    [ROUTES.ENTITLEMENTS]: {
      get: {
        summary: 'Evaluate every configured entitlement for a user.',
        parameters: [{ in: 'query', name: 'userId', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Map of entitlementId → { granted, source }.' },
        },
      },
    },
    [ROUTES.ADMIN_SUBSCRIPTIONS]: {
      get: {
        summary: 'Filtered, paginated subscription list (admin).',
        parameters: [
          { in: 'header', name: 'X-Admin-Secret', required: true, schema: { type: 'string' } },
          { in: 'query', name: 'userId', schema: { type: 'string' } },
          { in: 'query', name: 'status', schema: { type: 'string', enum: ['active', 'grace_period', 'on_hold', 'paused', 'expired', 'canceled', 'none'] } },
          { in: 'query', name: 'productId', schema: { type: 'string' } },
          { in: 'query', name: 'platform', schema: { type: 'string', enum: ['apple', 'google'] } },
          { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 200 } },
          { in: 'query', name: 'offset', schema: { type: 'integer', minimum: 0 } },
        ],
        responses: { 200: { description: 'OK' }, 401: { description: 'Invalid admin secret' } },
      },
    },
    '/onesub/admin/customers/{userId}': {
      get: {
        summary: 'Customer profile bundle: subscriptions + purchases + entitlements (admin).',
        parameters: [
          { in: 'header', name: 'X-Admin-Secret', required: true, schema: { type: 'string' } },
          { in: 'path', name: 'userId', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'OK' }, 401: { description: 'Invalid admin secret' } },
      },
    },
    '/onesub/admin/webhook-deadletters': {
      get: {
        summary: 'List failed webhook jobs (when a queue with DLQ support is configured).',
        parameters: [{ in: 'header', name: 'X-Admin-Secret', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'OK' }, 401: { description: 'Invalid admin secret' } },
      },
    },
    '/onesub/admin/webhook-replay/{id}': {
      post: {
        summary: 'Replay a dead-letter job through the webhook handler.',
        parameters: [
          { in: 'header', name: 'X-Admin-Secret', required: true, schema: { type: 'string' } },
          { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'OK' }, 401: { description: 'Invalid admin secret' } },
      },
    },
  },
  components: {
    schemas: {
      ValidateRequest: {
        type: 'object',
        required: ['userId', 'platform', 'productId', 'receipt'],
        properties: {
          userId: { type: 'string' },
          platform: { type: 'string', enum: ['apple', 'google'] },
          productId: { type: 'string' },
          receipt: { type: 'string', description: 'Apple JWS or Google purchaseToken' },
          purchaseType: { type: 'string', enum: ['subscription', 'consumable', 'non_consumable'] },
        },
      },
      ValidateResponse: {
        type: 'object',
        properties: {
          valid: { type: 'boolean' },
          subscription: { $ref: '#/components/schemas/SubscriptionInfo' },
          purchase: { $ref: '#/components/schemas/PurchaseInfo' },
        },
      },
      StatusResponse: {
        type: 'object',
        properties: {
          active: { type: 'boolean' },
          subscription: { $ref: '#/components/schemas/SubscriptionInfo' },
        },
      },
      SubscriptionInfo: {
        type: 'object',
        properties: {
          originalTransactionId: { type: 'string' },
          userId: { type: 'string' },
          productId: { type: 'string' },
          platform: { type: 'string', enum: ['apple', 'google'] },
          status: { type: 'string', enum: ['active', 'grace_period', 'on_hold', 'paused', 'expired', 'canceled', 'none'] },
          expiresAt: { type: 'string', format: 'date-time' },
          purchasedAt: { type: 'string', format: 'date-time' },
          willRenew: { type: 'boolean' },
        },
      },
      PurchaseInfo: {
        type: 'object',
        properties: {
          transactionId: { type: 'string' },
          userId: { type: 'string' },
          productId: { type: 'string' },
          platform: { type: 'string', enum: ['apple', 'google'] },
          type: { type: 'string', enum: ['consumable', 'non_consumable'] },
          quantity: { type: 'integer' },
          purchasedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    securitySchemes: {
      AdminSecret: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Admin-Secret',
      },
    },
  },
};

/**
 * Mount a route that serves the OpenAPI document. Useful for hosts that want
 * to expose `/openapi.json` to API explorers / SDK generators.
 *
 *   app.use('/openapi.json', openapiHandler());
 */
export function openapiHandler() {
  return (_req: import('express').Request, res: import('express').Response) => {
    res.json(ONESUB_OPENAPI);
  };
}
