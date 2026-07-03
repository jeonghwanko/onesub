/**
 * Bundle-size budget for @onesub/server.
 *
 * Uses `@size-limit/file` (raw gzipped file measurement) since this is a
 * server-side package — we don't need esbuild to re-bundle it for a
 * browser. Numbers below are aspirational ceilings; raise them only with
 * a deliberate justification.
 */
// 2026-07: raised 30/32 → 34 KB after two deliberate surface additions —
// webhookQueue wiring (queue-mode processors exported for standalone
// workers) and the full-parity OpenAPI spec (every mounted route
// documented). Measured 30.7/31.04 KB at the bump.
module.exports = [
  {
    name: 'esm bundle (gzipped)',
    path: 'dist/index.js',
    limit: '34 KB',
    gzip: true,
  },
  {
    name: 'cjs bundle (gzipped)',
    path: 'dist/index.cjs',
    limit: '34 KB',
    gzip: true,
  },
];
