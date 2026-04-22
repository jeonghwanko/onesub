import { describe, it, expect } from 'vitest';
import { ONESUB_ERROR_CODE } from '@onesub/shared';
import { OneSubError, isOneSubError, toOneSubError } from '../OneSubError.js';

describe('OneSubError', () => {
  it('sets name, code, and message', () => {
    const err = new OneSubError(ONESUB_ERROR_CODE.USER_CANCELLED, 'User tapped cancel');
    expect(err.name).toBe('OneSubError');
    expect(err.code).toBe('USER_CANCELLED');
    expect(err.message).toBe('User tapped cancel');
  });

  it('defaults message to the code when omitted', () => {
    const err = new OneSubError(ONESUB_ERROR_CODE.PURCHASE_TIMEOUT);
    expect(err.message).toBe('PURCHASE_TIMEOUT');
  });

  it('is an instanceof Error and OneSubError', () => {
    const err = new OneSubError(ONESUB_ERROR_CODE.INTERNAL_ERROR);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(OneSubError);
  });

  it('preserves cause when provided', () => {
    const original = new Error('underlying');
    const wrapped = new OneSubError(ONESUB_ERROR_CODE.NETWORK_ERROR, 'wrapped', original);
    expect(wrapped.cause).toBe(original);
  });
});

describe('isOneSubError', () => {
  it('returns true for OneSubError instances', () => {
    expect(isOneSubError(new OneSubError(ONESUB_ERROR_CODE.USER_CANCELLED))).toBe(true);
  });

  it('returns false for plain Error or other values', () => {
    expect(isOneSubError(new Error('x'))).toBe(false);
    expect(isOneSubError(null)).toBe(false);
    expect(isOneSubError('string')).toBe(false);
    expect(isOneSubError({ code: 'USER_CANCELLED' })).toBe(false);
  });
});

describe('toOneSubError', () => {
  it('returns the same OneSubError instance when given one', () => {
    const original = new OneSubError(ONESUB_ERROR_CODE.USER_CANCELLED);
    expect(toOneSubError(original)).toBe(original);
  });

  it('preserves a valid code from an error-like object', () => {
    const wrapped = toOneSubError({ code: 'USER_CANCELLED', message: 'cancelled' });
    expect(wrapped.code).toBe('USER_CANCELLED');
    expect(wrapped.message).toBe('cancelled');
  });

  it('falls back to INTERNAL_ERROR for unknown codes', () => {
    const wrapped = toOneSubError({ code: 'NOT_A_REAL_CODE', message: 'boom' });
    expect(wrapped.code).toBe(ONESUB_ERROR_CODE.INTERNAL_ERROR);
  });

  it('honors an explicit fallback code', () => {
    const wrapped = toOneSubError({ message: 'x' }, ONESUB_ERROR_CODE.NETWORK_ERROR);
    expect(wrapped.code).toBe(ONESUB_ERROR_CODE.NETWORK_ERROR);
  });

  it('wraps a bare string', () => {
    const wrapped = toOneSubError('fell over');
    expect(wrapped).toBeInstanceOf(OneSubError);
    expect(wrapped.code).toBe(ONESUB_ERROR_CODE.INTERNAL_ERROR);
    expect(wrapped.message).toContain('fell over');
  });
});
