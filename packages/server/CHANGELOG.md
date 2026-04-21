# @onesub/server

## 0.7.0

### Minor Changes

- df8dbf0: `@onesub/server`: `express`를 `peerDependencies`로 이동 (`"^4.17.0 || ^5.0.0"`).

  Middleware 라이브러리의 표준 패턴 — 호스트 앱이 가진 express 인스턴스를 그대로 사용하므로 이중 설치 / Router 인스턴스 mismatch 문제가 사라집니다. Express 4와 5 모두 지원.

  설치 시 호스트 앱에 `express`를 명시적으로 두세요:

  ```bash
  npm install @onesub/server express
  ```

  자세한 마이그레이션은 [`docs/MIGRATION.md`](https://github.com/jeonghwanko/onesub/blob/master/docs/MIGRATION.md)의 `0.6.x → 0.7.0` 섹션 참조.

  `@onesub/cli`: 생성 템플릿의 `@onesub/server` 버전 핀을 `^0.7.0`으로 갱신.

## 0.6.4

### Patch Changes

- e0b4da2: express 4 → 5 upgrade. Internal: admin DELETE route now validates params via zod (Express 5 types route params as `string | string[]`). No public API change.

## 0.6.3

### Patch Changes

- a62f241: OSS readiness pass: pluggable logger (`OneSubServerConfig.logger` / `setLogger`), canonical Postgres `sql/schema.sql` with runtime parity test, webhook retry semantics documented (4xx vs 5xx), per-package READMEs for npm, new `@onesub/cli` scaffolding package (`npx @onesub/cli init`), Apple Root CA G3 bundle protected by unit tests.

  No API breakage — all additions are backward compatible.

- Updated dependencies [a62f241]
  - @onesub/shared@0.3.2
