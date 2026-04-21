# @onesub/server

## 0.6.4

### Patch Changes

- e0b4da2: express 4 → 5 upgrade. Internal: admin DELETE route now validates params via zod (Express 5 types route params as `string | string[]`). No public API change.

## 0.6.3

### Patch Changes

- a62f241: OSS readiness pass: pluggable logger (`OneSubServerConfig.logger` / `setLogger`), canonical Postgres `sql/schema.sql` with runtime parity test, webhook retry semantics documented (4xx vs 5xx), per-package READMEs for npm, new `@onesub/cli` scaffolding package (`npx @onesub/cli init`), Apple Root CA G3 bundle protected by unit tests.

  No API breakage — all additions are backward compatible.

- Updated dependencies [a62f241]
  - @onesub/shared@0.3.2
