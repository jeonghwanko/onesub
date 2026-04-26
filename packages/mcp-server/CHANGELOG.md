# @onesub/mcp-server

## 0.3.12

### Patch Changes

- Updated dependencies [f4ef21f]
  - @onesub/shared@0.7.3

## 0.3.11

### Patch Changes

- Updated dependencies [bc1c343]
  - @onesub/shared@0.7.2

## 0.3.10

### Patch Changes

- Updated dependencies [8345e13]
  - @onesub/shared@0.7.1

## 0.3.9

### Patch Changes

- Updated dependencies [05ac535]
  - @onesub/shared@0.7.0

## 0.3.8

### Patch Changes

- Updated dependencies [10c5d0a]
  - @onesub/shared@0.6.0

## 0.3.7

### Patch Changes

- Updated dependencies [7b92dc8]
  - @onesub/shared@0.5.0

## 0.3.6

### Patch Changes

- Updated dependencies [fb1af23]
  - @onesub/shared@0.4.0

## 0.3.5

### Patch Changes

- ea361d5: MCP 도구 2개 추가 — AI 에이전트가 onesub dev 서버를 대상으로 통합 테스트 자동화 가능.

  **`onesub_simulate_purchase`**: `npx @onesub/cli dev`로 띄운 mockMode 서버에 결제 시나리오 요청 전송. `scenario: 'new' | 'revoked' | 'expired' | 'invalid' | 'network_error' | 'sandbox'`에 따라 `MOCK_*` prefix 영수증을 자동 구성. subscription은 `/onesub/validate`, consumable/non_consumable은 `/onesub/purchase/validate`로 라우팅. 응답의 HTTP 상태 + `action` + `errorCode`를 markdown으로 요약, scenario 기대값과 불일치 시 "Unexpected" 플래그.

  **`onesub_inspect_state`**: 한 userId의 subscription과 one-time 구매 상태를 서버에서 병렬로 조회해 통합 표로 반환. dev 서버가 내려가 있으면 `npx @onesub/cli dev`로 띄우라는 힌트 포함.

  AI 에이전트 활용 시나리오:

  - "이 앱의 결제 에러 핸들링이 제대로 되어 있는지 검증해줘" → simulate_purchase를 revoked/expired/invalid로 돌리고 앱 반응 확인
  - "사용자 u1의 구매 이력 보여줘" → inspect_state로 조회
  - "통합 테스트 시나리오 5개 만들어서 돌려줘" → 연쇄 호출

  MCP 도구 테스트 8 cases (fetch mocking으로 fetch 성공/실패/404/422 경로 커버).
  165 → 173 tests green.

## 0.3.4

### Patch Changes

- Updated dependencies [35b7ca1]
  - @onesub/shared@0.3.5

## 0.3.3

### Patch Changes

- Updated dependencies [63580dc]
  - @onesub/shared@0.3.4

## 0.3.2

### Patch Changes

- Updated dependencies [636ce9f]
  - @onesub/shared@0.3.3

## 0.3.1

### Patch Changes

- a62f241: OSS readiness pass: pluggable logger (`OneSubServerConfig.logger` / `setLogger`), canonical Postgres `sql/schema.sql` with runtime parity test, webhook retry semantics documented (4xx vs 5xx), per-package READMEs for npm, new `@onesub/cli` scaffolding package (`npx @onesub/cli init`), Apple Root CA G3 bundle protected by unit tests.

  No API breakage — all additions are backward compatible.

- Updated dependencies [a62f241]
  - @onesub/shared@0.3.2
