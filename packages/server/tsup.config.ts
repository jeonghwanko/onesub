import { defineConfig } from 'tsup';

/**
 * Dual ESM + CJS build for @onesub/server.
 *
 * Why both:
 *   - ESM (.js) for new Node 20+ projects using `"type": "module"`
 *   - CJS (.cjs) for the long tail of Express apps still on `require()`
 *
 * The TypeScript compiler emits ESM (handled by `tsc` separately for
 * `.d.ts`s). tsup produces both `.js` and `.cjs` from the same source set.
 *
 * `external` lists every peer / optional peer so they're not bundled — the
 * user installs them once at the top level.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  // Type declarations are emitted by `tsc` (npm run build:types) — tsup's
  // .d.ts emission is faster but doesn't honor project-references.
  dts: false,
  sourcemap: true,
  clean: false,
  splitting: false,
  treeshake: true,
  target: 'node20',
  // Note: rollup emits a MIXED_EXPORTS warning for the CJS build because
  // index.ts has both named exports and `export default createOneSubMiddleware`.
  // This is intentional — CJS consumers use `.default`, ESM consumers use the
  // named export. The warning is benign and cannot be suppressed via tsup's
  // rollupOptions (tsup intercepts onwarn before forwarding to rollup).
  external: [
    '@onesub/shared',
    'express',
    'jose',
    'zod',
    // Optional peers — never bundled
    'pg',
    'ioredis',
    'bullmq',
    '@opentelemetry/api',
  ],
});
