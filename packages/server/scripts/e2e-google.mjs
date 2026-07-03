/**
 * Google e2e — real service-account round-trips.
 *
 * 1. Mints a REAL Google-signed OIDC identity token (JWT-bearer grant with
 *    target_audience) for the configured service account.
 * 2. Boots @onesub/server with pushAudience + pushServiceAccountEmail and
 *    POSTs a Pub/Sub-shaped RTDN with that token — exercising
 *    verifyGooglePushToken (signature, audience, issuer, email claims)
 *    against tokens Google actually issues. The unknown purchaseToken also
 *    drives a real Play Developer API re-fetch (OAuth access-token mint +
 *    androidpublisher call; the fake token 4xx is expected and swallowed).
 * 3. Negatives: wrong-audience token and missing token must both 401.
 * 4. Optional: GOOGLE_E2E_PURCHASE_TOKEN validates a real purchase
 *    end-to-end (skipped when the secret is absent).
 *
 * Env (see .github/workflows/e2e.yml):
 *   GOOGLE_PACKAGE_NAME, GOOGLE_SERVICE_ACCOUNT_KEY,
 *   GOOGLE_E2E_PUSH_AUDIENCE (optional), GOOGLE_E2E_PURCHASE_TOKEN (optional)
 */
import { createSign } from 'node:crypto';
import express from 'express';
import { createOneSubMiddleware, InMemorySubscriptionStore, InMemoryPurchaseStore } from '@onesub/server';

const env = (name) => {
  const v = process.env[name];
  if (!v) {
    console.error(`MISSING env: ${name} — configure the repo secret (see e2e.yml)`);
    process.exit(1);
  }
  return v;
};

const packageName = env('GOOGLE_PACKAGE_NAME');
const serviceAccountKey = env('GOOGLE_SERVICE_ACCOUNT_KEY');
const pushAudience = process.env['GOOGLE_E2E_PUSH_AUDIENCE'] || 'https://onesub-e2e.invalid/onesub/webhook/google';
const purchaseToken = process.env['GOOGLE_E2E_PURCHASE_TOKEN'] || '';

const sa = JSON.parse(serviceAccountKey);
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** JWT-bearer grant with target_audience → Google-signed OIDC id_token. */
async function mintIdToken(audience) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'RS256', typ: 'JWT' });
  const payload = b64url({
    iss: sa.client_email, sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    target_audience: audience, iat: now, exp: now + 3600,
  });
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(sa.private_key, 'base64url');
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${payload}.${sig}`,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await resp.json();
  if (!resp.ok || !data.id_token) throw new Error(`id_token mint failed: ${JSON.stringify(data).slice(0, 300)}`);
  return data.id_token;
}

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + detail}`);
};

// ── real Google-signed OIDC tokens ───────────────────────────────────────────
const goodToken = await mintIdToken(pushAudience);
const wrongAudienceToken = await mintIdToken('https://wrong-audience.invalid');
console.log(`minted id_tokens for ${sa.client_email}`);

// ── boot the real server ─────────────────────────────────────────────────────
const app = express();
app.use(createOneSubMiddleware({
  database: { url: '' },
  google: {
    packageName,
    serviceAccountKey,
    pushAudience,
    pushServiceAccountEmail: sa.client_email,
  },
  store: new InMemorySubscriptionStore(),
  purchaseStore: new InMemoryPurchaseStore(),
}));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const rtdnBody = () => ({
  message: {
    data: Buffer.from(JSON.stringify({
      version: '1.0', packageName, eventTimeMillis: String(Date.now()),
      subscriptionNotification: {
        version: '1.0', notificationType: 4,
        purchaseToken: `e2e-nonexistent-token-${Date.now()}`, subscriptionId: 'e2e_product',
      },
    })).toString('base64'),
    messageId: `e2e-${Date.now()}`,
  },
  subscription: 'projects/e2e/subscriptions/e2e',
});

const postWebhook = async (auth) => {
  const r = await fetch(`${base}/onesub/webhook/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(rtdnBody()),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// 1 — real Google-signed token with the right audience/email passes
const ok = await postWebhook(goodToken);
check('RTDN with real OIDC token → 200 received', ok.status === 200 && ok.body.received === true, JSON.stringify(ok).slice(0, 300));

// 2 — wrong audience → 401
const wrongAud = await postWebhook(wrongAudienceToken);
check('wrong-audience token → 401', wrongAud.status === 401, JSON.stringify(wrongAud).slice(0, 300));

// 3 — missing token → 401
const noAuth = await postWebhook(null);
check('missing Authorization → 401', noAuth.status === 401, JSON.stringify(noAuth).slice(0, 300));

// 4 — optional: real purchase token end-to-end
if (purchaseToken) {
  const r = await fetch(`${base}/onesub/purchase/validate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'google', receipt: purchaseToken, userId: 'e2e-user', productId: process.env['GOOGLE_E2E_PRODUCT_ID'] ?? 'e2e_product', type: 'non_consumable' }),
  });
  const body = await r.json().catch(() => ({}));
  check('real purchase token validate → 200 valid', r.status === 200 && body.valid === true, JSON.stringify(body).slice(0, 300));
} else {
  console.log('SKIP  real purchase token validate (GOOGLE_E2E_PURCHASE_TOKEN not set)');
}

server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
