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
//
// 2026-07-26: raised 34 → 36 KB for the Apple x5c chain-verification cache
// (`providers/verified-key-cache.ts`), which stops every receipt and webhook
// re-walking the certificate chain and re-importing the leaf key.
// Measured 33.56/33.94 KB at the bump — the addition itself is +0.66 KB.
//
// The prior entry's figures had already drifted before that change: the tree
// measured 32.78/33.15 KB with the cache reverted, i.e. ~2 KB of growth
// accumulated under the 34 KB ceiling without a recorded bump. It left 0.06 KB
// of headroom, so an unrelated commit would have failed this gate. Re-measure
// and record here when the numbers move, not only when the limit is raised.
//
// 2026-07-26: 34.17/34.55 KB after the metrics aggregation split and response
// cache (`metrics-aggregate.ts`, `metrics-cache.ts`). Limit unchanged.
module.exports = [
  {
    name: 'esm bundle (gzipped)',
    path: 'dist/index.js',
    limit: '36 KB',
    gzip: true,
  },
  {
    name: 'cjs bundle (gzipped)',
    path: 'dist/index.cjs',
    limit: '36 KB',
    gzip: true,
  },
];
