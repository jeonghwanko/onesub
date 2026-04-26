import { describe, it, expect } from 'vitest';
import { ROUTES, DEFAULT_PORT, SUBSCRIPTION_STATUS } from '../constants.js';

describe('shared constants', () => {
  describe('ROUTES', () => {
    it('ROUTES.VALIDATE equals /onesub/validate', () => {
      expect(ROUTES.VALIDATE).toBe('/onesub/validate');
    });

    it('ROUTES.STATUS equals /onesub/status', () => {
      expect(ROUTES.STATUS).toBe('/onesub/status');
    });

    it('ROUTES.WEBHOOK_APPLE equals /onesub/webhook/apple', () => {
      expect(ROUTES.WEBHOOK_APPLE).toBe('/onesub/webhook/apple');
    });

    it('ROUTES.WEBHOOK_GOOGLE equals /onesub/webhook/google', () => {
      expect(ROUTES.WEBHOOK_GOOGLE).toBe('/onesub/webhook/google');
    });
  });

  describe('DEFAULT_PORT', () => {
    it('DEFAULT_PORT equals 4100', () => {
      expect(DEFAULT_PORT).toBe(4100);
    });
  });

  describe('SUBSCRIPTION_STATUS', () => {
    it('ACTIVE equals "active"', () => {
      expect(SUBSCRIPTION_STATUS.ACTIVE).toBe('active');
    });

    it('GRACE_PERIOD equals "grace_period"', () => {
      expect(SUBSCRIPTION_STATUS.GRACE_PERIOD).toBe('grace_period');
    });

    it('ON_HOLD equals "on_hold"', () => {
      expect(SUBSCRIPTION_STATUS.ON_HOLD).toBe('on_hold');
    });

    it('EXPIRED equals "expired"', () => {
      expect(SUBSCRIPTION_STATUS.EXPIRED).toBe('expired');
    });

    it('CANCELED equals "canceled"', () => {
      expect(SUBSCRIPTION_STATUS.CANCELED).toBe('canceled');
    });

    it('NONE equals "none"', () => {
      expect(SUBSCRIPTION_STATUS.NONE).toBe('none');
    });
  });
});
