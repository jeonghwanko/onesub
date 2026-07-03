/**
 * Optional OpenTelemetry tracing.
 *
 * `@opentelemetry/api` is an optional peer dependency — when it's installed
 * onesub wraps its hot paths in spans. When it isn't, every span helper is
 * a zero-cost no-op (no dynamic import, no Promise overhead).
 *
 * Why a custom helper instead of @opentelemetry/instrumentation-express:
 * the express instrumentation traces every request, but onesub's interesting
 * spans are specific operations (Apple JWT mint, Google OAuth refresh,
 * receipt validation, webhook dispatch). Hand-spanned hot paths give
 * actionable traces without doubling latency-tracker overhead.
 */

import { createRequire } from 'node:module';

type Tracer = {
  startActiveSpan: <T>(name: string, fn: (span: Span) => T) => T;
};

type Span = {
  setAttribute: (key: string, value: string | number | boolean) => void;
  recordException: (err: unknown) => void;
  setStatus: (status: { code: number; message?: string }) => void;
  end: () => void;
};

const NOOP_SPAN: Span = {
  setAttribute: () => {},
  recordException: () => {},
  setStatus: () => {},
  end: () => {},
};

/**
 * Lazy-loaded tracer. We don't reach for `@opentelemetry/api` until the
 * first `withSpan` call so process startup pays nothing when otel is absent.
 */
let cachedTracer: Tracer | null = null;
let resolved = false;

function getTracer(): Tracer | null {
  if (resolved) return cachedTracer;
  resolved = true;
  try {
    // Resolve synchronously — otel api is CJS-friendly. In the CJS bundle the
    // native `require` exists, so use it directly; in ESM we mint one via
    // createRequire(import.meta.url). The `typeof require` guard matters for
    // the CJS output: tsup's esbuild pass lowers `import.meta` to an empty
    // object there (shims are off in tsup.config.ts), so that expression must
    // only be evaluated on the ESM path — where it is fully supported.
    const req: NodeRequire =
      typeof require === 'function' ? require : createRequire(import.meta.url);
    const otel = req('@opentelemetry/api') as { trace: { getTracer: (n: string, v: string) => Tracer } };
    cachedTracer = otel.trace.getTracer('@onesub/server', '1.0.0');
    return cachedTracer;
  } catch {
    return null;
  }
}

/**
 * Wrap an async operation in a span. When otel isn't installed the function
 * runs unmodified — no span object is allocated.
 *
 * Use for operations whose latency or failure rate is operationally
 * interesting: receipt validation, store writes, outbound API calls.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  if (!tracer) return fn(NOOP_SPAN);

  return tracer.startActiveSpan(name, async (span) => {
    for (const [k, v] of Object.entries(attributes)) span.setAttribute(k, v);
    try {
      const result = await fn(span);
      // status code 1 = OK, 2 = ERROR (avoid importing the enum from otel api)
      span.setStatus({ code: 1 });
      return result;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: 2, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
