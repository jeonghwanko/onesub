import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve @onesub/shared to SOURCE, not to its gitignored `dist`.
      //
      // Dependents import the compiled output, which is not rebuilt
      // automatically and has no tsconfig path mapping. Vitest transpiles
      // without type-checking, so before this alias a newly added value export
      // that was missing from a stale `dist` was simply `undefined` at
      // runtime — a comparison would quietly never match and the suite stayed
      // green. That failure mode is silent and specific to `npm test`; `tsc`
      // catches the same staleness loudly via the stale `.d.ts`.
      //
      // Builds and type-checks still go through `dist`, so this does not
      // remove the need to run `npm run build -w @onesub/shared` before a
      // dependent build or type-check.
      '@onesub/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // Unbounded fork startup can starve the jsdom SDK worker on Windows and
    // produce a false 60s "worker failed to respond" error before tests run.
    maxWorkers: 4,
    include: ['packages/*/src/**/__tests__/**/*.test.ts'],
  },
});
