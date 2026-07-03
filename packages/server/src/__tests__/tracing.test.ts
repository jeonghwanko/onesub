import { describe, expect, it } from 'vitest';
import { withSpan } from '../tracing.js';

/**
 * @opentelemetry/api is an optional peer and is NOT installed in this repo,
 * so these tests exercise the fallback path: getTracer() must resolve to
 * null without throwing (createRequire lookup fails → caught) and withSpan
 * must run the wrapped function unmodified with a no-op span.
 */
describe('withSpan (otel absent)', () => {
  it('runs the function and returns its result', async () => {
    const result = await withSpan('test.op', { key: 'value' }, async (span) => {
      // The no-op span must be safely callable.
      span.setAttribute('a', 1);
      span.setStatus({ code: 1 });
      span.end();
      return 42;
    });
    expect(result).toBe(42);
  });

  it('propagates errors from the wrapped function', async () => {
    await expect(
      withSpan('test.fail', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
