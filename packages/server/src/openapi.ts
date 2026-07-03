/**
 * OpenAPI 3.1 spec for the onesub HTTP surface.
 *
 * Hand-maintained — kept in sync with the routes by a parity test (see
 * __tests__/openapi.test.ts) that mounts every router via
 * `createOneSubMiddleware`, walks the express router stack, and asserts every
 * mounted path+method is described here (and vice versa — no stale spec
 * entries). Generated clients live downstream:
 *
 *   - swagger-typescript-api → typed fetch client
 *   - openapi-generator-cli  → Kotlin/Swift/etc. clients
 *
 * Why hand-maintained instead of zod-to-openapi: the routes use zod for
 * input validation but the request/response shapes the public docs need are
 * a thin slice of those internal types. Hand-writing keeps the doc readable
 * without coupling client output to internal validation strictness changes.
 */

import { ONESUB_ERROR_CODE, ROUTES } from '@onesub/shared';

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

// ── shared fragments ─────────────────────────────────────────────────────────
// Every onesub 4xx/5xx goes through `sendError` (errors.ts) and carries
// `{ error, errorCode }`; some routes append shape-compat fields such as
// `valid: false` / `subscription: null`.

const ERROR_CONTENT = {
  'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
};

/** Error-response entry: description + the canonical `{ error, errorCode }` body. */
const err = (description: string) => ({ description, content: ERROR_CONTENT });

/** `X-Admin-Secret` header — required on every admin + metrics route. */
const ADMIN_SECRET_PARAM = {
  in: 'header',
  name: 'X-Admin-Secret',
  required: true,
  schema: { type: 'string' },
};

/** Shared `from`/`to`/`groupBy` query params for windowed metrics endpoints. */
const METRICS_RANGE_PARAMS = [
  { in: 'query', name: 'from', required: true, schema: { type: 'string', format: 'date-time' }, description: 'Window start (ISO 8601).' },
  { in: 'query', name: 'to', required: true, schema: { type: 'string', format: 'date-time' }, description: 'Window end (ISO 8601).' },
  { in: 'query', name: 'groupBy', schema: { type: 'string', enum: ['none', 'day'] }, description: "'day' adds a zero-filled daily `buckets` series to the response." },
];

export const ONESUB_OPENAPI: OpenAPIDoc = {
  openapi: '3.1.0',
  info: {
    title: 'onesub HTTP API',
    version: '1.0.0',
    description:
      'Receipt validation, subscription status, one-time purchases, entitlements, webhooks, metrics, and admin endpoints exposed by `createOneSubMiddleware`.',
  },
  servers: [
    { url: 'http://localhost:4100', description: 'Local dev (examples/server)' },
  ],
  paths: {
    // ── public: subscriptions ────────────────────────────────────────────────
    [ROUTES.VALIDATE]: {
      post: {
        summary: 'Validate an Apple/Google receipt and persist subscription state.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidateRequest' } } },
        },
        responses: {
          200: { description: 'Validation succeeded; subscription state persisted.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidateResponse' } } } },
          400: err('Bad request — missing fields, malformed receipt, package mismatch.'),
          409: err('Receipt is account-bound to a different userId (TRANSACTION_BELONGS_TO_OTHER_USER).'),
          422: err('Receipt validation failed (RECEIPT_VALIDATION_FAILED).'),
        },
      },
    },
    [ROUTES.STATUS]: {
      get: {
        summary: 'Fetch the most recent subscription state for a user.',
        parameters: [{ in: 'query', name: 'userId', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/StatusResponse' } } } },
          400: err('Missing userId or userId too long (INVALID_INPUT / USER_ID_TOO_LONG).'),
        },
      },
    },
    // ── public: one-time purchases ───────────────────────────────────────────
    [ROUTES.VALIDATE_PURCHASE]: {
      post: {
        summary: 'Validate a consumable / non-consumable receipt and record the purchase.',
        description:
          'Non-consumables are idempotent: an already-owned product returns the stored purchase with `action: "restored"`. Consumable receipts can only be redeemed once.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidatePurchaseRequest' } } },
        },
        responses: {
          200: { description: 'Purchase validated — freshly recorded (`action: "new"`) or restored.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ValidatePurchaseResponse' } } } },
          400: err('Bad request — missing/invalid fields (INVALID_INPUT).'),
          409: err('Receipt is account-bound or already redeemed by another user (TRANSACTION_BELONGS_TO_OTHER_USER).'),
          422: err('Receipt validation failed (RECEIPT_VALIDATION_FAILED).'),
        },
      },
    },
    [ROUTES.PURCHASE_STATUS]: {
      get: {
        summary: 'List all recorded purchases for a user, optionally filtered by product.',
        parameters: [
          { in: 'query', name: 'userId', required: true, schema: { type: 'string' } },
          { in: 'query', name: 'productId', schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/PurchaseStatusResponse' } } } },
          400: err('Missing/invalid userId (INVALID_INPUT).'),
        },
      },
    },
    // ── webhooks ─────────────────────────────────────────────────────────────
    [ROUTES.WEBHOOK_APPLE]: {
      post: {
        summary: 'Apple App Store Server Notification V2 receiver.',
        description:
          'Apple POSTs `{ signedPayload }`. JWS-verified, idempotent when `webhookEventStore` is configured.',
        responses: {
          200: { description: 'Acknowledged.' },
          400: err('Missing or invalid signedPayload.'),
        },
      },
    },
    [ROUTES.WEBHOOK_GOOGLE]: {
      post: {
        summary: 'Google Play Real-Time Developer Notification (Pub/Sub push) receiver.',
        responses: {
          200: { description: 'Acknowledged.' },
          400: err('Missing message.data or package mismatch.'),
          401: err('pushAudience configured and JWT verification failed.'),
        },
      },
    },
    // ── entitlements (mounted when config.entitlements is set) ──────────────
    [ROUTES.ENTITLEMENT]: {
      get: {
        summary: 'Evaluate a single configured entitlement for a user.',
        parameters: [
          { in: 'query', name: 'userId', required: true, schema: { type: 'string' } },
          { in: 'query', name: 'id', required: true, schema: { type: 'string' }, description: 'Entitlement id from `config.entitlements`.' },
        ],
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/EntitlementResponse' } } } },
          400: err('userId and id are required (INVALID_INPUT).'),
          404: err('Unknown entitlement id (ENTITLEMENT_NOT_FOUND).'),
        },
      },
    },
    [ROUTES.ENTITLEMENTS]: {
      get: {
        summary: 'Evaluate every configured entitlement for a user.',
        parameters: [{ in: 'query', name: 'userId', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Map of entitlementId → EntitlementStatus.', content: { 'application/json': { schema: { $ref: '#/components/schemas/EntitlementsResponse' } } } },
          400: err('userId is required (INVALID_INPUT).'),
        },
      },
    },
    // ── admin (mounted when config.adminSecret is set) ───────────────────────
    [ROUTES.ADMIN_SUBSCRIPTIONS]: {
      get: {
        summary: 'Filtered, paginated subscription list (admin).',
        parameters: [
          ADMIN_SECRET_PARAM,
          { in: 'query', name: 'userId', schema: { type: 'string' } },
          { in: 'query', name: 'status', schema: { type: 'string', enum: ['active', 'grace_period', 'on_hold', 'paused', 'expired', 'canceled', 'none'] } },
          { in: 'query', name: 'productId', schema: { type: 'string' } },
          { in: 'query', name: 'platform', schema: { type: 'string', enum: ['apple', 'google'] } },
          { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 200 } },
          { in: 'query', name: 'offset', schema: { type: 'integer', minimum: 0 } },
        ],
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/ListSubscriptionsResponse' } } } },
          400: err('Invalid filter/pagination params (INVALID_INPUT).'),
          401: err('Invalid admin secret (INVALID_ADMIN_SECRET).'),
        },
      },
    },
    '/onesub/admin/subscriptions/{transactionId}': {
      get: {
        summary: 'Single subscription record by originalTransactionId (admin).',
        parameters: [
          ADMIN_SECRET_PARAM,
          { in: 'path', name: 'transactionId', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/SubscriptionInfo' } } } },
          400: err('transactionId required (INVALID_INPUT).'),
          401: err('Invalid admin secret (INVALID_ADMIN_SECRET).'),
          404: err('No record for this transactionId (TRANSACTION_NOT_FOUND).'),
        },
      },
    },
    '/onesub/admin/customers/{userId}': {
      get: {
        summary: 'Customer profile bundle: subscriptions + purchases + entitlements (admin).',
        parameters: [
          ADMIN_SECRET_PARAM,
          { in: 'path', name: 'userId', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'OK — empty arrays mean "no record of this user" (never 404).', content: { 'application/json': { schema: { $ref: '#/components/schemas/CustomerProfileResponse' } } } },
          400: err('userId required (INVALID_INPUT).'),
          401: err('Invalid admin secret (INVALID_ADMIN_SECRET).'),
        },
      },
    },
    '/onesub/admin/sync-apple/{originalTransactionId}': {
      post: {
        summary: 'Reconcile one subscription from the Apple Status API into the local store (admin).',
        parameters: [
          ADMIN_SECRET_PARAM,
          { in: 'path', name: 'originalTransactionId', required: true, schema: { type: 'string' } },
          { in: 'query', name: 'sandbox', schema: { type: 'string', enum: ['true'] }, description: 'Force the sandbox Status API host (otherwise inferred from the stored record).' },
        ],
        responses: {
          200: { description: 'Fresh state fetched and upserted.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, subscription: { $ref: '#/components/schemas/SubscriptionInfo' } } } } } },
          400: err('originalTransactionId missing or Apple API credentials not configured (INVALID_INPUT / APPLE_CONFIG_MISSING).'),
          401: err('Invalid admin secret (INVALID_ADMIN_SECRET).'),
          404: err('Apple Status API returned no record (TRANSACTION_NOT_FOUND).'),
        },
      },
    },
    '/onesub/purchase/admin/{userId}/{productId}': {
      delete: {
        summary: 'Reset a purchase so the user can test the flow again (admin).',
        parameters: [
          ADMIN_SECRET_PARAM,
          { in: 'path', name: 'userId', required: true, schema: { type: 'string' } },
          { in: 'path', name: 'productId', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, deleted: { type: 'integer', description: 'Number of purchase rows removed.' } } } } } },
          400: err('userId and productId required (INVALID_INPUT).'),
          401: err('Invalid admin secret (INVALID_ADMIN_SECRET).'),
        },
      },
    },
    '/onesub/purchase/admin/transfer': {
      post: {
        summary: 'Reassign a transactionId to a new userId — device/account migration (admin).',
        parameters: [ADMIN_SECRET_PARAM],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['transactionId', 'newUserId'], properties: { transactionId: { type: 'string' }, newUserId: { type: 'string' } } } } },
        },
        responses: {
          200: { description: 'Transferred.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, purchase: { $ref: '#/components/schemas/PurchaseInfo' } } } } } },
          400: err('Missing/invalid body fields (INVALID_INPUT).'),
          401: err('Invalid admin secret (INVALID_ADMIN_SECRET).'),
          404: err('No purchase with this transactionId (TRANSACTION_NOT_FOUND).'),
        },
      },
    },
    '/onesub/purchase/admin/grant': {
      post: {
        summary: 'Manually insert a purchase record, skipping store verification (admin).',
        parameters: [ADMIN_SECRET_PARAM],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/GrantPurchaseRequest' } } },
        },
        responses: {
          200: { description: 'Granted.', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, purchase: { $ref: '#/components/schemas/PurchaseInfo' } } } } } },
          400: err('Missing/invalid body fields (INVALID_INPUT).'),
          401: err('Invalid admin secret (INVALID_ADMIN_SECRET).'),
        },
      },
    },
    '/onesub/admin/webhook-deadletters': {
      get: {
        summary: 'List failed webhook jobs (when a queue with DLQ support is configured).',
        parameters: [ADMIN_SECRET_PARAM],
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', description: 'DeadLetterRecord: { id, job, attemptsMade, lastError, failedAt }.' } } } } } } },
          401: err('Invalid admin secret (INVALID_ADMIN_SECRET).'),
        },
      },
    },
    '/onesub/admin/webhook-replay/{id}': {
      post: {
        summary: 'Replay a dead-letter job through the webhook handler.',
        parameters: [
          ADMIN_SECRET_PARAM,
          { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'OK' },
          400: err('id required (INVALID_INPUT).'),
          401: err('Invalid admin secret (INVALID_ADMIN_SECRET).'),
        },
      },
    },
    // ── metrics (mounted when config.adminSecret is set) ─────────────────────
    [ROUTES.METRICS_ACTIVE]: {
      get: {
        summary: 'Snapshot of currently-entitled users (active subs + non-consumable owners).',
        parameters: [ADMIN_SECRET_PARAM],
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/MetricsActiveResponse' } } } },
          401: err('Invalid admin secret (INVALID_ADMIN_SECRET).'),
        },
      },
    },
    [ROUTES.METRICS_STARTED]: {
      get: {
        summary: 'Subscriptions started (purchasedAt) within a window.',
        parameters: [ADMIN_SECRET_PARAM, ...METRICS_RANGE_PARAMS],
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/MetricsCountResponse' } } } },
          400: err('from/to missing, non-ISO, or from > to (INVALID_INPUT).'),
          401: err('Invalid admin secret (INVALID_ADMIN_SECRET).'),
        },
      },
    },
    [ROUTES.METRICS_EXPIRED]: {
      get: {
        summary: 'Subscriptions expired/canceled (expiresAt) within a window.',
        parameters: [ADMIN_SECRET_PARAM, ...METRICS_RANGE_PARAMS],
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/MetricsCountResponse' } } } },
          400: err('from/to missing, non-ISO, or from > to (INVALID_INPUT).'),
          401: err('Invalid admin secret (INVALID_ADMIN_SECRET).'),
        },
      },
    },
    [ROUTES.METRICS_PURCHASES_STARTED]: {
      get: {
        summary: 'Non-consumable purchases started (purchasedAt) within a window.',
        parameters: [ADMIN_SECRET_PARAM, ...METRICS_RANGE_PARAMS],
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/MetricsCountResponse' } } } },
          400: err('from/to missing, non-ISO, or from > to (INVALID_INPUT).'),
          401: err('Invalid admin secret (INVALID_ADMIN_SECRET).'),
        },
      },
    },
    // ── Apple Promotional Offer signing (mounted when offerKeyId + offerPrivateKey set) ──
    [ROUTES.APPLE_OFFER_SIGNATURE]: {
      post: {
        summary: 'Sign an Apple Promotional Offer payload server-side (ES256).',
        description:
          'The client passes the returned `{ keyId, nonce, timestamp, signature }` to StoreKit to redeem the offer. When `config.adminSecret` is set, the request must carry `X-Onesub-Offer-Secret` with the same value.',
        parameters: [
          { in: 'header', name: 'X-Onesub-Offer-Secret', required: false, schema: { type: 'string' }, description: 'Required (must equal config.adminSecret) when adminSecret is configured.' },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/OfferSignatureRequest' } } },
        },
        responses: {
          200: { description: 'Signed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/OfferSignatureResponse' } } } },
          400: err('Missing/invalid body fields or apple.bundleId not configured (INVALID_INPUT / APPLE_CONFIG_MISSING).'),
          401: err('Offer secret missing or wrong (UNAUTHORIZED).'),
        },
      },
    },
  },
  components: {
    schemas: {
      ErrorResponse: {
        type: 'object',
        required: ['error', 'errorCode'],
        description:
          'Canonical error body — every onesub 4xx/5xx carries it. Some routes append shape-compat fields (e.g. `valid: false`, `subscription: null`, `purchases: []`).',
        properties: {
          error: { type: 'string', description: 'Human-readable message.' },
          errorCode: { type: 'string', enum: Object.values(ONESUB_ERROR_CODE), description: 'Machine-readable canonical code.' },
        },
      },
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
      ValidatePurchaseRequest: {
        type: 'object',
        required: ['userId', 'platform', 'productId', 'receipt', 'type'],
        properties: {
          userId: { type: 'string' },
          platform: { type: 'string', enum: ['apple', 'google'] },
          productId: { type: 'string' },
          receipt: { type: 'string', description: 'Apple JWS or Google purchaseToken' },
          type: { type: 'string', enum: ['consumable', 'non_consumable'] },
        },
      },
      ValidatePurchaseResponse: {
        type: 'object',
        properties: {
          valid: { type: 'boolean' },
          purchase: { $ref: '#/components/schemas/PurchaseInfo' },
          action: { type: 'string', enum: ['new', 'restored'], description: 'Present on valid:true — "restored" means the transactionId was already recorded (idempotent retry or reassignment).' },
        },
      },
      PurchaseStatusResponse: {
        type: 'object',
        properties: {
          purchases: { type: 'array', items: { $ref: '#/components/schemas/PurchaseInfo' } },
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
      EntitlementStatus: {
        type: 'object',
        required: ['active', 'source'],
        properties: {
          active: { type: 'boolean' },
          source: { type: ['string', 'null'], enum: ['subscription', 'purchase', null], description: 'Where the entitlement came from when active; null when not active.' },
          productId: { type: 'string', description: 'Matched productId (only when active).' },
          expiresAt: { type: 'string', format: 'date-time', description: 'Only when source === "subscription".' },
        },
      },
      EntitlementResponse: {
        allOf: [
          { $ref: '#/components/schemas/EntitlementStatus' },
          { type: 'object', required: ['id'], properties: { id: { type: 'string', description: 'The entitlement id queried, echoed back.' } } },
        ],
      },
      EntitlementsResponse: {
        type: 'object',
        properties: {
          entitlements: { type: 'object', additionalProperties: { $ref: '#/components/schemas/EntitlementStatus' } },
        },
      },
      ListSubscriptionsResponse: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/SubscriptionInfo' } },
          total: { type: 'integer', description: 'Total matches before limit/offset.' },
          limit: { type: 'integer' },
          offset: { type: 'integer' },
        },
      },
      CustomerProfileResponse: {
        type: 'object',
        properties: {
          userId: { type: 'string' },
          subscriptions: { type: 'array', items: { $ref: '#/components/schemas/SubscriptionInfo' } },
          purchases: { type: 'array', items: { $ref: '#/components/schemas/PurchaseInfo' } },
          entitlements: { type: 'object', additionalProperties: { $ref: '#/components/schemas/EntitlementStatus' }, description: 'Omitted when the server has no entitlements config.' },
        },
      },
      GrantPurchaseRequest: {
        type: 'object',
        required: ['userId', 'productId', 'platform'],
        properties: {
          userId: { type: 'string' },
          productId: { type: 'string' },
          platform: { type: 'string', enum: ['apple', 'google'] },
          type: { type: 'string', enum: ['consumable', 'non_consumable'], default: 'non_consumable' },
          transactionId: { type: 'string', description: 'Auto-generated `admin_grant_*` id when omitted.' },
        },
      },
      MetricsActiveResponse: {
        type: 'object',
        properties: {
          total: { type: 'integer', description: 'Active subs + grace_period subs + non-consumable owners.' },
          activeSubscriptions: { type: 'integer' },
          gracePeriodSubscriptions: { type: 'integer' },
          nonConsumablePurchases: { type: 'integer' },
          byProduct: { type: 'object', additionalProperties: { type: 'integer' }, description: 'Subscription product distribution (subs only).' },
          byProductPurchases: { type: 'object', additionalProperties: { type: 'integer' }, description: 'Non-consumable purchase distribution.' },
          byPlatform: { type: 'object', additionalProperties: { type: 'integer' } },
        },
      },
      MetricsBucket: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'UTC calendar day, YYYY-MM-DD.' },
          count: { type: 'integer' },
        },
      },
      MetricsCountResponse: {
        type: 'object',
        properties: {
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
          total: { type: 'integer' },
          byProduct: { type: 'object', additionalProperties: { type: 'integer' } },
          byPlatform: { type: 'object', additionalProperties: { type: 'integer' } },
          buckets: { type: 'array', items: { $ref: '#/components/schemas/MetricsBucket' }, description: 'Only present with ?groupBy=day — zero-filled, sorted ascending.' },
        },
      },
      OfferSignatureRequest: {
        type: 'object',
        required: ['productId', 'offerId', 'applicationUsername'],
        properties: {
          productId: { type: 'string' },
          offerId: { type: 'string', description: 'Promotional offer id defined in App Store Connect.' },
          applicationUsername: { type: 'string', description: 'Unique per-request UUID (the nonce seed).' },
        },
      },
      OfferSignatureResponse: {
        type: 'object',
        required: ['keyId', 'nonce', 'timestamp', 'signature'],
        properties: {
          keyId: { type: 'string' },
          nonce: { type: 'string' },
          timestamp: { type: 'integer', description: 'Milliseconds since epoch.' },
          signature: { type: 'string', description: 'Base64 ES256 signature for StoreKit.' },
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
