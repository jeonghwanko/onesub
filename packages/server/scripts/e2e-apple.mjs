/**
 * Apple sandbox/production e2e — real App Store Server API round-trip.
 *
 * 1. Mints an ES256 JWT with the configured ASC-issued key and fetches the
 *    transaction history for APPLE_E2E_TRANSACTION_ID — the response carries
 *    a REAL Apple-signed JWS (signedTransactions[0]).
 * 2. Boots @onesub/server (no mockMode, no skipJwsVerification) and POSTs the
 *    JWS to the same route the mobile client uses, asserting the full
 *    pipeline: x5c chain verification against Apple roots, bundleId check,
 *    account-binding guard, store write.
 * 3. Negative: a tampered JWS must be rejected (proves verification is live).
 *
 * Env (see .github/workflows/e2e.yml):
 *   APPLE_BUNDLE_ID, APPLE_KEY_ID, APPLE_ISSUER_ID, APPLE_PRIVATE_KEY,
 *   APPLE_E2E_TRANSACTION_ID
 *
 * Read-only against Apple; all writes go to an in-memory store.
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

const bundleId = env('APPLE_BUNDLE_ID');
const keyId = env('APPLE_KEY_ID');
const issuerId = env('APPLE_ISSUER_ID');
const privateKey = env('APPLE_PRIVATE_KEY');
const transactionId = env('APPLE_E2E_TRANSACTION_ID');

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** App Store Server API JWT — note the `bid` claim (unlike the ASC API). */
function serverApiJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'ES256', kid: keyId, typ: 'JWT' });
  const payload = b64url({ iss: issuerId, iat: now, exp: now + 900, aud: 'appstoreconnect-v1', bid: bundleId });
  const sign = createSign('SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }, 'base64url');
  return `${header}.${payload}.${sig}`;
}

const HOSTS = {
  production: 'https://api.storekit.itunes.apple.com',
  sandbox: 'https://api.storekit-sandbox.itunes.apple.com',
};

async function fetchSignedTransaction() {
  let lastErr = '';
  for (const [envName, host] of Object.entries(HOSTS)) {
    const resp = await fetch(`${host}/inApps/v1/history/${encodeURIComponent(transactionId)}?sort=DESCENDING`, {
      headers: { Authorization: `Bearer ${serverApiJwt()}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.ok && Array.isArray(body.signedTransactions) && body.signedTransactions.length > 0) {
      console.log(`Apple ${envName} history: ${body.signedTransactions.length} signed transaction(s)`);
      return body.signedTransactions[0];
    }
    lastErr = `${envName} ${resp.status}: ${JSON.stringify(body).slice(0, 200)}`;
    console.log(`Apple ${envName} lookup miss — ${lastErr}`);
  }
  throw new Error(`transaction ${transactionId} not found in production or sandbox — ${lastErr}`);
}

const decodeJwsPayload = (jws) => JSON.parse(Buffer.from(jws.split('.')[1], 'base64url').toString());

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + detail}`);
};

// ── real Apple-signed JWS ────────────────────────────────────────────────────
const signedJws = await fetchSignedTransaction();
const tx = decodeJwsPayload(signedJws);
console.log(`transaction: productId=${tx.productId} type=${tx.type} env=${tx.environment} appAccountToken=${tx.appAccountToken ? 'set' : 'absent'}`);
check('history JWS matches expected bundleId', tx.bundleId === bundleId, `got ${tx.bundleId}`);

// ── boot the real server ─────────────────────────────────────────────────────
const app = express();
app.use(createOneSubMiddleware({
  database: { url: '' },
  // productReceiptMaxAgeHours: the e2e transaction is a real historical
  // purchase, deliberately older than the default 72h replay window.
  apple: { bundleId, keyId, issuerId, privateKey, productReceiptMaxAgeHours: 24 * 365 * 10 },
  store: new InMemorySubscriptionStore(),
  purchaseStore: new InMemoryPurchaseStore(),
}));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const post = async (path, body) => {
  const r = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const userId = tx.appAccountToken ?? 'e2e-user';
const isSubscription = tx.type === 'Auto-Renewable Subscription';

if (isSubscription) {
  const v = await post('/onesub/validate', { platform: 'apple', receipt: signedJws, userId, productId: tx.productId });
  check('subscription validate (real Apple JWS) → 200 valid', v.status === 200 && v.body.valid === true, JSON.stringify(v).slice(0, 300));
} else {
  const type = tx.type === 'Consumable' ? 'consumable' : 'non_consumable';
  const v = await post('/onesub/purchase/validate', { platform: 'apple', receipt: signedJws, userId, productId: tx.productId, type });
  check('purchase validate (real Apple JWS) → 200 valid', v.status === 200 && v.body.valid === true, JSON.stringify(v).slice(0, 300));
}

// ── tampered JWS must be rejected (verification is live, not skipped) ────────
const [h, p, s] = signedJws.split('.');
const tamperedPayload = b64url({ ...decodeJwsPayload(signedJws), productId: 'tampered_product' });
const tampered = `${h}.${tamperedPayload}.${s}`;
const t = isSubscription
  ? await post('/onesub/validate', { platform: 'apple', receipt: tampered, userId, productId: 'tampered_product' })
  : await post('/onesub/purchase/validate', { platform: 'apple', receipt: tampered, userId, productId: 'tampered_product', type: 'non_consumable' });
check('tampered JWS → 422 rejected', t.status === 422, JSON.stringify(t).slice(0, 300));

server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
