import { describe, expect, it } from 'vitest';
import { ONESUB_OPENAPI } from '../openapi.js';
import { ROUTES } from '@onesub/shared';

describe('OpenAPI document', () => {
  it('declares every public route', () => {
    const declared = Object.keys(ONESUB_OPENAPI.paths);
    // Spot-check the main public routes — the spec is hand-written, so this
    // is the parity guard. Routes added to ROUTES that aren't in the spec
    // should fail this test.
    for (const path of [
      ROUTES.VALIDATE,
      ROUTES.STATUS,
      ROUTES.WEBHOOK_APPLE,
      ROUTES.WEBHOOK_GOOGLE,
      ROUTES.ENTITLEMENTS,
      ROUTES.ADMIN_SUBSCRIPTIONS,
    ]) {
      expect(declared).toContain(path);
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
});
