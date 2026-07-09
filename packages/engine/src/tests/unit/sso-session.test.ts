/**
 * SSO session bridge (lib/security/sso-session.ts) — over CannedDb.
 *
 * createBetterAuthSession mints a Better-Auth-compatible session: it inserts
 * a `session` row with EXACT camelCase columns and returns a signed
 * `better-auth.session_token` cookie. These tests pin the secret guard, the
 * insert shape, the HMAC signature (recomputed independently), and the
 * SameSite/Secure cookie-flag matrix.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { createBetterAuthSession } from '../../lib/security/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const SECRET = 'test-secret-minimum-32-characters-long-xx';

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

/** Independently recompute the HMAC-SHA256 base64 signature the helper uses. */
async function hmacB64(value: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

afterEach(() => {
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.NODE_ENV;
});

describe('createBetterAuthSession', () => {
  it('throws when BETTER_AUTH_SECRET is unset', async () => {
    // Guarantee the precondition regardless of what ran earlier in the suite —
    // other unit tests (tenant cache HMAC, integration fixtures) may leave
    // BETTER_AUTH_SECRET set in the shared process env.
    delete process.env.BETTER_AUTH_SECRET;
    const db = new CannedDb();
    await expect(createBetterAuthSession(asDb(db), 'user-1')).rejects.toThrow(
      'BETTER_AUTH_SECRET is not set',
    );
    expect(db.log).toHaveLength(0);
  });

  it('inserts a session row with camelCase columns + the user id and null defaults', async () => {
    process.env.BETTER_AUTH_SECRET = SECRET;
    const db = new CannedDb();
    const { token } = await createBetterAuthSession(asDb(db), 'user-42');

    const insert = db.executed(/insert into session/i)[0]!;
    expect(insert.sql).toContain('"userId"');
    expect(insert.sql).toContain('"expiresAt"');
    expect(insert.sql).toContain('"ipAddress"');
    expect(insert.parameters).toContain('user-42');
    expect(insert.parameters).toContain(token);
    // ipAddress + userAgent default to null when not supplied
    expect(insert.parameters.filter((p) => p === null)).toHaveLength(2);
    // Better-Auth-shaped token: url-safe, ~32 chars
    expect(token).toMatch(/^[A-Za-z0-9_-]{30,44}$/);
  });

  it('signs the cookie exactly like Hono setSignedCookie (token.HMAC, url-encoded)', async () => {
    process.env.BETTER_AUTH_SECRET = SECRET;
    const db = new CannedDb();
    const { token, setCookie } = await createBetterAuthSession(asDb(db), 'u');

    const cookieVal = setCookie.split(';')[0]!.replace('better-auth.session_token=', '');
    const decoded = decodeURIComponent(cookieVal);
    const expectedSig = await hmacB64(token, SECRET);
    expect(decoded).toBe(`${token}.${expectedSig}`);
  });

  it('defaults to SameSite=Lax, HttpOnly, Path=/, and the requested Max-Age', async () => {
    process.env.BETTER_AUTH_SECRET = SECRET;
    const db = new CannedDb();
    const { setCookie } = await createBetterAuthSession(asDb(db), 'u', { ttlSeconds: 3600 });

    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=3600');
    // not secure outside production / cross-domain
    expect(setCookie).not.toContain('Secure');
  });

  it('emits SameSite=None; Secure for a cross-domain session', async () => {
    process.env.BETTER_AUTH_SECRET = SECRET;
    const db = new CannedDb();
    const { setCookie } = await createBetterAuthSession(asDb(db), 'u', { crossDomain: true });
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).toContain('Secure');
  });

  it('adds Secure in production even for a same-site cookie', async () => {
    process.env.BETTER_AUTH_SECRET = SECRET;
    process.env.NODE_ENV = 'production';
    const db = new CannedDb();
    const { setCookie } = await createBetterAuthSession(asDb(db), 'u');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Secure');
  });

  it('forwards ipAddress + userAgent into the row when provided', async () => {
    process.env.BETTER_AUTH_SECRET = SECRET;
    const db = new CannedDb();
    await createBetterAuthSession(asDb(db), 'u', {
      ipAddress: '10.0.0.1',
      userAgent: 'Mozilla/5.0',
    });
    const insert = db.executed(/insert into session/i)[0]!;
    expect(insert.parameters).toContain('10.0.0.1');
    expect(insert.parameters).toContain('Mozilla/5.0');
  });
});
