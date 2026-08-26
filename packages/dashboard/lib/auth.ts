import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient, OneSubFetchError, type OneSubClient } from './onesub-client';
import { COOKIE_MAX_AGE_SECONDS, COOKIE_NAME } from './session-constants';
import { openAdminSession, sealAdminSession, type AdminSession } from './session';

const SERVER_URL_ENV = 'ONESUB_SERVER_URL';
const SESSION_SECRET_ENV = 'ONESUB_SESSION_SECRET';
const developmentSessionSecret = randomBytes(32).toString('base64url');

function getSessionKeyMaterial(): string {
  const configured = process.env[SESSION_SECRET_ENV];
  if (configured) {
    if (configured.length < 32) {
      throw new Error(
        `[onesub-dashboard] ${SESSION_SECRET_ENV} must be at least 32 characters.`,
      );
    }
    return configured;
  }
  if (process.env.NODE_ENV !== 'production') return developmentSessionSecret;
  throw new Error(
    `[onesub-dashboard] ${SESSION_SECRET_ENV} must be set in production.`,
  );
}

export function getServerUrl(): string {
  const url = process.env[SERVER_URL_ENV];
  if (!url) {
    throw new Error(
      `[onesub-dashboard] ${SERVER_URL_ENV} is not set. ` +
        'Point it at your @onesub/server instance, e.g. http://localhost:4100',
    );
  }
  return url;
}

export async function readAdminSession(): Promise<AdminSession | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  return token ? openAdminSession(token, getSessionKeyMaterial()) : null;
}

export async function writeAdminSession(adminSecret: string): Promise<string> {
  const store = await cookies();
  const { token, sessionId } = sealAdminSession(adminSecret, getSessionKeyMaterial());
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: '/',
  });
  return sessionId;
}

export async function clearAdminSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

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
    if (err instanceof Error) return { ok: false, reason: err.message };
    return { ok: false, reason: 'unknown error' };
  }
}

export async function requireSession(): Promise<{ client: OneSubClient; sessionId: string }> {
  const session = await readAdminSession();
  if (!session) redirect('/login');
  return {
    client: createClient(getServerUrl(), session.adminSecret),
    sessionId: session.sessionId,
  };
}

export async function requireClient(): Promise<OneSubClient> {
  return (await requireSession()).client;
}
