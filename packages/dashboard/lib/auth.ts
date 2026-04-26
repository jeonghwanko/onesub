/**
 * Cookie-based admin auth.
 *
 * The HTTP-only cookie stores the onesub adminSecret directly. Acceptable for
 * a v0.1 single-operator dashboard since:
 *   - cookies are HttpOnly + Secure (in production), so XSS / JS access blocked
 *   - server actions are CSRF-protected by Next.js
 *   - the cookie content equals the env var the server already trusts
 *
 * Phase 3 will introduce a token-exchange layer (cookie holds an opaque session
 * id; secret stays env-only) when multi-operator + audit log land.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient, OneSubFetchError, type OneSubClient } from './onesub-client';

export const COOKIE_NAME = 'onesub_admin';
export const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 8;  // 8h — operator session

const SERVER_URL_ENV = 'ONESUB_SERVER_URL';

export function getServerUrl(): string {
  const url = process.env[SERVER_URL_ENV];
  if (!url) {
    throw new Error(
      `[onesub-dashboard] ${SERVER_URL_ENV} is not set. ` +
        `Point it at your @onesub/server instance, e.g. http://localhost:4100`,
    );
  }
  return url;
}

export async function readAdminSecret(): Promise<string | null> {
  const store = await cookies();
  return store.get(COOKIE_NAME)?.value ?? null;
}

export async function writeAdminSecret(secret: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, secret, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: '/',
  });
}

export async function clearAdminSecret(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

/**
 * Probe the onesub server with the candidate secret. Used by the login server
 * action — successful 200 means the secret is valid. We use the cheapest
 * admin endpoint (`/metrics/active`) so even an empty deployment responds fast.
 */
export async function verifyAdminSecret(secret: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const client = createClient(getServerUrl(), secret);
    await client.getActiveMetrics();
    return { ok: true };
  } catch (err) {
    if (err instanceof OneSubFetchError && err.status === 401) {
      return { ok: false, reason: 'admin secret rejected' };
    }
    if (err instanceof OneSubFetchError && err.status === 404) {
      return { ok: false, reason: 'metrics endpoint not mounted — server adminSecret may be unset' };
    }
    if (err instanceof Error) {
      return { ok: false, reason: err.message };
    }
    return { ok: false, reason: 'unknown error' };
  }
}

/**
 * Server-component helper: ensure the request is authenticated and return a
 * configured client. Redirects to /login when the cookie is missing.
 */
export async function requireClient(): Promise<OneSubClient> {
  const secret = await readAdminSecret();
  if (!secret) redirect('/login');
  return createClient(getServerUrl(), secret);
}
