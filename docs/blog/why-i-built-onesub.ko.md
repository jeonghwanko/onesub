---
title: RevenueCat 안 쓰고 IAP 직접 구현해본 후기 — 3주간 삽질하며 배운 것
tags: react-native, iap, 인앱결제, 오픈소스, expo
description: React Native 앱에서 RevenueCat 없이 구독을 굴리며 부딪힌 StoreKit 2 JWS 체인 검증, Google Play v3 라이프사이클, 3일 환불 함정, 그리고 결국 MIT 오픈소스로 추출한 이야기.
canonical_url: https://github.com/jeonghwanko/onesub/blob/master/docs/blog/why-i-built-onesub.md
thumbnail: https://raw.githubusercontent.com/jeonghwanko/onesub/master/docs/blog/cover-why-i-built-onesub.png
---

![cover](https://raw.githubusercontent.com/jeonghwanko/onesub/master/docs/blog/cover-why-i-built-onesub.png)

> 영문 원문: [dev.to](https://dev.to/_9848c5582063b42abecb7/i-built-my-own-iap-backend-instead-of-using-revenuecat-what-3-weeks-of-pain-taught-me-1l06)
> 코드: [github.com/jeonghwanko/onesub](https://github.com/jeonghwanko/onesub)

구독 기반 React Native 앱을 만들면서 RN 솔로 개발자라면 누구나 한 번 부딪히는
질문 — **"RevenueCat 쓸까, 직접 만들까?"** — 을 거쳤다. 결국 직접 만들기를
택했고, 예상보다 훨씬 많은 엣지 케이스에 부딪혔고, 그 결과물을 MIT 라이브러리로
추출했다. 같은 길을 갈 사람들에게 시간을 절약시켜주려고 회고를 남긴다.

## 왜 RevenueCat을 안 썼는가

분명히 해두자 — RevenueCat은 좋은 서비스다. 많은 앱에 정답이다.
나에게 맞지 않았던 두 가지:

1. **레브뉴 쉐어가 같이 자란다.** $2.5K MRR 이후 1%는 합리적인 가격이지만,
   이 영역은 제품의 평생을 함께할 인프라다. 임대보다 소유하고 싶었다.
2. **구독 상태가 그쪽 DB에 산다.** 어차피 "유저 X가 구독 중"이라는 정보를
   내 Postgres에 동기화해서 다른 데이터와 조인해야 한다. 즉 RevenueCat 웹훅
   핸들러를 어차피 돌려야 한다는 얘기. 한 단계 더 거치는 비용을 내는 느낌이었다.

그래서 직접 만들기 시작했다. 시간이 어디로 흘러갔는지 정리해본다.

## 시간을 가장 많이 잡아먹은 것들

### Apple StoreKit 2 JWS 검증 (~2일)

JWT를 그냥 신뢰하면 안 된다. JWT 헤더의 `x5c` 인증서 체인을 따라 올라가며
각 인증서를 **Apple Root CA G3** 기준으로 검증하고, 그 다음 leaf 인증서의
공개키로 JWT 서명을 검증해야 한다. 내가 찾은 튜토리얼 중 전체 체인을 검증하는
건 거의 없었다 — 대부분 payload만 디코딩하고 끝이었다.

### Google Play Developer API v3 (~1일)

OAuth2 서비스 어카운트는 별 거 없다. **함정은 v1 vs v2 API다.**
`purchases.subscriptionsv2.get`을 써야 한다 — 라이프사이클 상태로 깔끔하게
매핑되는 `subscriptionState` enum을 반환한다. v1 API는 그게 없고, 스택오버플로
답변 대부분이 아직 v1을 참조하고 있다.

`expiryTimeMillis` + `cancelReason`으로 상태를 추론하지 말고 그냥 enum을 읽으면 된다.

### 라이프사이클 상태 분류 (~3일)

여기가 진짜 험난했다.

- Apple: `DID_FAIL_TO_RENEW` + subtype `GRACE_PERIOD` vs `GRACE_PERIOD_EXPIRED`
- Google: `IN_GRACE_PERIOD`, `ON_HOLD`, `SUBSCRIPTION_PAUSED`

게이팅용으로 `active: boolean`이 필요하지만, UX를 위해 raw 상태도 필요했다.
"카드 결제 실패했지만 아직 사용 가능"과 "구독이 정지됨"은 분명히 다른 메시지다.

두 벤더의 이벤트를 하나의 상태 머신으로 정리하는 데 몇 번을 다시 썼다.

### 3일 환불 함정

Google은 `acknowledgePurchase`를 3일 안에 호출하지 않으면 자동 환불한다.
첫 버전에서는 호출 안 했다. 내가 따라간 RN 튜토리얼 어디에도 언급이 없었다.
대시보드에서 패턴을 발견하기 전에 테스트 결제 몇 건을 잃었다. **구독도 일회성
IAP도 둘 다 acknowledge 필요하다.**

### 웹훅 누락 복구

Apple App Store Server Notifications V2는 reliable이지만 guaranteed는 아니다.
하나라도 놓치면 유저 상태가 어긋난다. 해법: `/status` 체크 시 App Store Server
API로 직접 fetch — 웹훅을 "유일한 경로"가 아니라 "빠른 경로"로 취급한다.
Google RTDN도 마찬가지로 `subscriptionsv2.get` 폴백을 둔다.

## 결국 추출한 것

프로덕션에서 동작하기 시작하니 위 작업 중 어느 것도 앱에 종속적이지 않았다.
그래서 분리했다 → [github.com/jeonghwanko/onesub](https://github.com/jeonghwanko/onesub)

한 줄:

```ts
app.use(createOneSubMiddleware(config));
```

MIT 라이센스. 구독 스토어는 pluggable (Postgres 빌트인, 인터페이스 구현하면
Redis든 뭐든 OK). React Native SDK는 옵션 (`useOneSub()` 훅 + paywall
컴포넌트) — 서버는 어떤 클라이언트든 받아준다 (Flutter, native, plain fetch).

## 솔직한 한계

- **분석 대시보드 없음.** RevenueCat의 진짜 해자는 영수증 검증이 아니라
  코호트 리텐션 / LTV / 실험이다. 셀프호스트 Docker 대시보드가 있긴 한데
  운영용(active count, failed webhook)이지 코호트 분석은 아니다.
- **호스티드 버전 없음.** 본인 서버를 굴려야 한다. "MVP 빨리 띄우고 인프라
  관리 안 하고 싶다"가 목표면 아직 RevenueCat이 더 낫다.
- 일부 고급 기능(Apple Family Sharing, Promotional Offer 서명, Google
  oneTimeProductNotification)은 최근 추가된 상태. 안정화는 더 필요.

## 의외로 흥미롭게 나온 부분

- **MCP 서버 동봉.** Claude Code나 Cursor에 연결해놓고 "이 Expo 앱에 월간
  구독 추가해줘"라고 하면 App Store Connect 상품, Play Console 상품, 클라이언트
  연동 코드를 한 번에 만들어준다. 메인 기능은 아니었는데 마찰이 너무 줄어서
  본인이 더 놀랐다.
- **296+ 테스트.** 위 라이프사이클 부분의 multi-notification e2e 시나리오 포함.
  실제 버그는 거기서 거의 다 잡혔다.

## 묻고 싶은 것

RN에서 IAP 직접 구현해본 분 중에, 위에 안 적힌 엣지 케이스로 데인 적 있나요?
특히 **Family Sharing**이나 **upgrade/downgrade chain** 프로덕션에서
다뤄본 경험이 있다면 좋을 듯.

---

*레포: [github.com/jeonghwanko/onesub](https://github.com/jeonghwanko/onesub) — MIT, 이슈와 PR 환영합니다.*
