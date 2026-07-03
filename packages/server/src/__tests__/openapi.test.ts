/**
 * OpenAPI parity tests.
 *
 * The spec (openapi.ts) is hand-maintained, so the guard here has to be
 * mechanical: mount EVERY router via `createOneSubMiddleware` (adminSecret +
 * entitlements + both mock platforms + offer keys + a DLQ-capable queue so
 * every conditional router mounts), walk the express router stack to extract
 * each registered path+method, and assert both directions:
 *
 *   1. every mounted route is documented (no undocumented endpoints)
 *   2. every documented path is actually mounted (no stale spec entries)
 *
 * Express params (`:userId`) are normalized to OpenAPI form (`{userId}`).
 */

import { describe, expect, it } from 'vitest';
import { ONESUB_OPENAPI } from '../openapi.js';
import { ONESUB_ERROR_CODE, ROUTES } from '@onesub/shared';
import { createOneSubMiddleware } from '../index.js';
import type { WebhookQueue, DeadLetterRecord } from '../webhook-queue.js';

// ── route extraction ─────────────────────────────────────────────────────────

/** Minimal shape of an express 5 / router 2.x layer. */
interface RouterLayer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
  handle?: { stack?: RouterLayer[] };
}

/** Recursively collect every registered route (method + path) from a router stack. */
function collectRoutes(stack: RouterLayer[], out: Array<{ method: string; path: string }>): void {
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const path of paths) {
        for (const method of Object.keys(layer.route.methods)) {
          if (method === '_all') continue;
          out.push({ method, path });
        }
      }
    } else if (layer.handle?.stack) {
      // Nested router (router.use(subRouter)) — recurse. All onesub routers
      // are mounted at the root, so no prefix accumulation is needed.
      collectRoutes(layer.handle.stack, out);
    }
  }
}

/** Express `:param` → OpenAPI `{param}`. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** Fake queue exposing the optional DLQ methods so the dead-letter admin routes mount. */
const dlqQueue: WebhookQueue = {
  async enqueue(): Promise<void> {},
  setHandler(): void {},
  async listDeadLetters(): Promise<DeadLetterRecord[]> {
    return [];
  },
  async replayDeadLetter(): Promise<void> {},
};

/**
 * Build the middleware with every conditional router enabled:
 *   - apple + google (mockMode) → validate / purchase / webhook / sync routes
 *   - offerKeyId + offerPrivateKey → apple offer-signature route
 *   - adminSecret → admin + metrics routers
 *   - entitlements → entitlement routes
 *   - DLQ-capable webhookQueue → dead-letter + replay admin routes
 */
function mountedRoutes(): Array<{ method: string; path: string }> {
  const router = createOneSubMiddleware({
    apple: {
      bundleId: 'com.example.app',
      mockMode: true,
      offerKeyId: 'OFFER_KEY_ID',
      offerPrivateKey: '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----',
    },
    google: { packageName: 'com.example.app', mockMode: true },
    database: { url: '' },
    adminSecret: 's3cr3t',
    entitlements: { premium: { productIds: ['pro_monthly'] } },
    webhookQueue: dlqQueue,
  });
  const out: Array<{ method: string; path: string }> = [];
  collectRoutes((router as unknown as { stack: RouterLayer[] }).stack, out);
  return out;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('OpenAPI document', () => {
  it('documents every mounted route (spec ⊇ router)', () => {
    const routes = mountedRoutes();
    // Sanity: the walk actually found the full surface — if this drops, the
    // extraction broke (express internals changed), not the spec.
    expect(routes.length).toBeGreaterThanOrEqual(22);

    for (const { method, path } of routes) {
      const specPath = toOpenApiPath(path);
      const entry = ONESUB_OPENAPI.paths[specPath] as Record<string, unknown> | undefined;
      expect(entry, `spec is missing path ${specPath} (mounted as ${method.toUpperCase()} ${path})`).toBeDefined();
      expect(entry?.[method], `spec is missing operation ${method.toUpperCase()} ${specPath}`).toBeDefined();
    }
  });

  it('has no stale spec entries (router ⊇ spec)', () => {
    const mounted = new Set(
      mountedRoutes().map(({ method, path }) => `${method} ${toOpenApiPath(path)}`),
    );
    for (const [specPath, entry] of Object.entries(ONESUB_OPENAPI.paths)) {
      for (const method of Object.keys(entry as Record<string, unknown>)) {
        expect(mounted.has(`${method} ${specPath}`), `spec declares ${method.toUpperCase()} ${specPath} but no router mounts it`).toBe(true);
      }
    }
  });

  it('declares every ROUTES constant', () => {
    const declared = Object.keys(ONESUB_OPENAPI.paths);
    for (const path of Object.values(ROUTES)) {
      expect(declared).toContain(toOpenApiPath(path));
    }
  });

  it('uses 3.1.0', () => {
    expect(ONESUB_OPENAPI.openapi).toBe('3.1.0');
  });

  it('declares the AdminSecret security scheme', () => {
    expect(ONESUB_OPENAPI.components.securitySchemes.AdminSecret).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'X-Admin-Secret',
    });
  });

  it('enumerates every canonical error code in ErrorResponse', () => {
    const schema = ONESUB_OPENAPI.components.schemas.ErrorResponse as {
      properties: { errorCode: { enum: string[] } };
    };
    expect(schema.properties.errorCode.enum.sort()).toEqual(
      Object.values(ONESUB_ERROR_CODE).sort(),
    );
  });

  // Spot checks — schema accuracy for the newly-documented surfaces.

  it('documents the purchase validate request/response schemas', () => {
    const post = (ONESUB_OPENAPI.paths[ROUTES.VALIDATE_PURCHASE] as Record<string, unknown>)['post'] as {
      requestBody: { content: Record<string, { schema: { $ref: string } }> };
      responses: Record<string, unknown>;
    };
    expect(post.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/ValidatePurchaseRequest',
    );
    // 409 (account binding / cross-user replay) and 422 (validation failure)
    // are the load-bearing purchase error codes.
    expect(Object.keys(post.responses)).toEqual(expect.arrayContaining(['200', '400', '409', '422']));

    const reqSchema = ONESUB_OPENAPI.components.schemas.ValidatePurchaseRequest as { required: string[] };
    expect(reqSchema.required.sort()).toEqual(['platform', 'productId', 'receipt', 'type', 'userId']);
  });

  it('documents metrics range params (from/to required, groupBy enum)', () => {
    for (const path of [ROUTES.METRICS_STARTED, ROUTES.METRICS_EXPIRED, ROUTES.METRICS_PURCHASES_STARTED]) {
      const get = (ONESUB_OPENAPI.paths[path] as Record<string, unknown>)['get'] as {
        parameters: Array<{ name: string; in: string; required?: boolean; schema?: { enum?: string[] } }>;
      };
      const byName = new Map(get.parameters.map((p) => [p.name, p]));
      expect(byName.get('X-Admin-Secret')?.in).toBe('header');
      expect(byName.get('from')?.required).toBe(true);
      expect(byName.get('to')?.required).toBe(true);
      expect(byName.get('groupBy')?.schema?.enum).toEqual(['none', 'day']);
    }
  });

  it('documents the Apple offer-signature route with its dedicated secret header', () => {
    const post = (ONESUB_OPENAPI.paths[ROUTES.APPLE_OFFER_SIGNATURE] as Record<string, unknown>)['post'] as {
      parameters: Array<{ name: string; in: string }>;
      responses: Record<string, { content?: Record<string, { schema: { $ref: string } }> }>;
    };
    expect(post.parameters.some((p) => p.name === 'X-Onesub-Offer-Secret' && p.in === 'header')).toBe(true);
    expect(post.responses['200']?.content?.['application/json'].schema.$ref).toBe(
      '#/components/schemas/OfferSignatureResponse',
    );

    const respSchema = ONESUB_OPENAPI.components.schemas.OfferSignatureResponse as { required: string[] };
    expect(respSchema.required.sort()).toEqual(['keyId', 'nonce', 'signature', 'timestamp']);
  });

  it('references shared SubscriptionInfo/PurchaseInfo schemas instead of duplicating', () => {
    const json = JSON.stringify(ONESUB_OPENAPI.paths);
    expect(json).toContain('#/components/schemas/SubscriptionInfo');
    expect(json).toContain('#/components/schemas/PurchaseInfo');
    // The paths section must not re-declare the record shape inline — the
    // `willRenew` field only exists on the shared SubscriptionInfo component.
    expect(json).not.toContain('willRenew');
  });
});
