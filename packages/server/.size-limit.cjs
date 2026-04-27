/**
 * Bundle-size budget for @onesub/server.
 *
 * Uses `@size-limit/file` (raw gzipped file measurement) since this is a
 * server-side package — we don't need esbuild to re-bundle it for a
 * browser. Numbers below are aspirational ceilings; raise them only with
 * a deliberate justification.
 */
module.exports = [
  {
    name: 'esm bundle (gzipped)',
    path: 'dist/index.js',
    limit: '30 KB',
    gzip: true,
  },
  {
    name: 'cjs bundle (gzipped)',
    path: 'dist/index.cjs',
    limit: '32 KB',
    gzip: true,
  },
];
