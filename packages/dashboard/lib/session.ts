import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { COOKIE_MAX_AGE_SECONDS } from './session-constants';

const SESSION_VERSION = 1;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

interface SessionPayload {
  version: typeof SESSION_VERSION;
  adminSecret: string;
  sessionId: string;
  expiresAt: number;
}
export interface AdminSession {
  adminSecret: string;
  sessionId: string;
  expiresAt: number;
}

function deriveKey(keyMaterial: string): Buffer {
  if (keyMaterial.length < 32) {
    throw new Error('[onesub-dashboard] Session key material must be at least 32 characters.');
  }
  return createHash('sha256').update(keyMaterial, 'utf8').digest();
}

export function sealAdminSession(
  adminSecret: string,
  keyMaterial: string,
  now = Date.now(),
): { token: string; sessionId: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(keyMaterial), iv);
  const sessionId = randomUUID();
  const payload: SessionPayload = {
    version: SESSION_VERSION,
    adminSecret,
    sessionId,
    expiresAt: now + COOKIE_MAX_AGE_SECONDS * 1_000,
  };
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const token = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  return { token, sessionId };
}

export function openAdminSession(
  token: string,
  keyMaterial: string,
  now = Date.now(),
): AdminSession | null {
  try {
    const envelope = Buffer.from(token, 'base64url');
    if (envelope.length <= IV_BYTES + AUTH_TAG_BYTES) return null;
    const iv = envelope.subarray(0, IV_BYTES);
    const authTag = envelope.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
    const ciphertext = envelope.subarray(IV_BYTES + AUTH_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(keyMaterial), iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const payload = JSON.parse(plaintext) as Partial<SessionPayload>;

    if (
      payload.version !== SESSION_VERSION ||
      typeof payload.adminSecret !== 'string' ||
      typeof payload.sessionId !== 'string' ||
      typeof payload.expiresAt !== 'number' ||
      payload.expiresAt <= now
    ) {
      return null;
    }
    return {
      adminSecret: payload.adminSecret,
      sessionId: payload.sessionId,
      expiresAt: payload.expiresAt,
    };
  } catch {
    return null;
  }
}
