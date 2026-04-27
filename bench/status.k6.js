/**
 * onesub k6 benchmark — /onesub/status read path.
 *
 * Run locally:
 *   docker compose -f examples/server/docker-compose.yml up -d
 *   k6 run -e BASE_URL=http://localhost:4100 bench/status.k6.js
 *
 * Tunables:
 *   VUS    — concurrent virtual users (default 50)
 *   DUR    — duration (default 30s)
 *   USERS  — total distinct userIds to rotate through (default 1000)
 *
 * What it measures: end-to-end latency of GET /onesub/status, which exercises
 * the SubscriptionStore.getByUserId path. Compare in-memory (REDIS_URL unset),
 * Redis (REDIS_URL set, no DATABASE_URL), and Postgres (DATABASE_URL set).
 */
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: Number(__ENV.VUS ?? 50),
  duration: __ENV.DUR ?? '30s',
  thresholds: {
    http_req_duration: ['p(95)<100', 'p(99)<300'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:4100';
const USER_COUNT = Number(__ENV.USERS ?? 1000);

export default function () {
  const userId = `bench-user-${Math.floor(Math.random() * USER_COUNT)}`;
  const res = http.get(`${BASE_URL}/onesub/status?userId=${userId}`);
  check(res, {
    '200 ok': (r) => r.status === 200,
    'has active field': (r) => r.json('active') !== undefined,
  });
}
