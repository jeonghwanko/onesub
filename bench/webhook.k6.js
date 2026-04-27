/**
 * onesub k6 benchmark — Google webhook ingestion path.
 *
 * Sends synthetic Pub/Sub-shaped Google notifications. Apple's JWS path is
 * harder to benchmark synthetically (requires signing) — use the e2e
 * sandbox workflow for Apple-side perf instead.
 *
 * Run:
 *   k6 run -e BASE_URL=http://localhost:4100 -e VUS=20 bench/webhook.k6.js
 *
 * The server must be configured with `apple.skipJwsVerification: false`
 * disabled? No — we exercise Google here, so Apple config is irrelevant.
 * Set `webhookEventStore` so duplicate messageIds get deduped on the way in.
 */
import http from 'k6/http';
import { check } from 'k6';
import encoding from 'k6/encoding';

export const options = {
  vus: Number(__ENV.VUS ?? 20),
  duration: __ENV.DUR ?? '30s',
  thresholds: {
    http_req_duration: ['p(95)<200', 'p(99)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:4100';
const PACKAGE_NAME = __ENV.GOOGLE_PACKAGE_NAME ?? 'com.example.app';

function buildPayload(token, messageId) {
  const inner = JSON.stringify({
    version: '1.0',
    packageName: PACKAGE_NAME,
    eventTimeMillis: String(Date.now()),
    subscriptionNotification: {
      version: '1.0',
      notificationType: 4, // SUBSCRIPTION_PURCHASED
      purchaseToken: token,
      subscriptionId: 'pro_monthly',
    },
  });
  return JSON.stringify({
    message: {
      data: encoding.b64encode(inner),
      messageId,
    },
    subscription: 'projects/example/subscriptions/onesub',
  });
}

export default function () {
  const token = `bench-token-${__VU}-${__ITER}`;
  const messageId = `bench-msg-${__VU}-${__ITER}-${Date.now()}`;
  const res = http.post(
    `${BASE_URL}/onesub/webhook/google`,
    buildPayload(token, messageId),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(res, {
    '200 ok': (r) => r.status === 200,
  });
}
