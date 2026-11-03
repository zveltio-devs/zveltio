// A refused credential on a data-API read is a 401, never a visitor.
//
// ADR 0017 runs a credential-less read as the tenant's `public` role. #1502
// kept a refused API key out of that path, but not a refused session: a signed
// out (or expired, or forged) session cookie, or a bearer token that is no
// session, came back as `public` — 403/404 where `public` holds no grant, or
// 200 with `public`'s rows where it does. The SDK re-authenticates only on 401,
// so such a client sat on "forbidden" instead of being sent to sign in.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { getEnforcer, invalidateAllPermissionCaches } from '../../lib/tenancy/index.js';
import {
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT_A = '00000000-0000-0000-0000-000000000001';
const SFX = String(Date.now()).slice(-7);
const OPEN = `refopen_${SFX}`; // `public` may read it
const SHUT = `refshut_${SFX}`; // `public` may not

d('a refused credential on a data read is 401, not a visitor', () => {
  let app: Hono;
  let db: Database;
  let live = '';
  let stale = '';

  const get = (coll: string, headers: Record<string, string> = {}) =>
    app.request(`/api/data/${coll}`, { headers });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    const text = { name: 'title', type: 'text', required: false, unique: false, indexed: false };
    for (const name of [OPEN, SHUT])
      await DDLManager.createCollection(db, { name, fields: [text] } as never);
    await (await getEnforcer()).addPolicy('public', TENANT_A, OPEN, 'read');
    await invalidateAllPermissionCaches();
    const grants = [OPEN, SHUT].map((collection) => ({ collection, actions: ['read'] }));
    live = (await createMemberSession(app, db, { grants })).cookie;
    stale = (await createMemberSession(app, db, { grants })).cookie;
    // Valid, then signed out: the browser still holds the cookie.
    expect((await get(SHUT, { cookie: stale })).status).toBe(200);
    const out = await app.request('/api/auth/sign-out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: stale },
      body: '{}',
    });
    expect(out.status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await (await getEnforcer()).removePolicy('public', TENANT_A, OPEN, 'read').catch(() => {});
    await invalidateAllPermissionCaches();
    for (const name of [OPEN, SHUT]) await dropTestCollection(db, name).catch(() => {});
  });

  it('a signed-out session cookie: 401 whether or not `public` may read', async () => {
    for (const coll of [SHUT, OPEN]) {
      expect([coll, (await get(coll, { cookie: stale })).status]).toEqual([coll, 401]);
    }
    expect(
      (await app.request(`/api/data/${SHUT}`, { method: 'HEAD', headers: { cookie: stale } }))
        .status,
    ).toBe(401);
    expect((await app.request('/api/data', { headers: { cookie: stale } })).status).toBe(401);
  });

  it('a forged session cookie, plain or `__Secure-`: 401', async () => {
    for (const cookie of [
      'better-auth.session_token=forged.value',
      '__Secure-better-auth.session_token=forged.value',
    ]) {
      expect([cookie, (await get(OPEN, { cookie })).status]).toEqual([cookie, 401]);
    }
  });

  it('an Authorization header that is no credential, any scheme: 401', async () => {
    for (const authorization of ['Bearer garbage', 'bearer garbage', 'Basic Zm9vOmJhcg==']) {
      expect([authorization, (await get(OPEN, { authorization })).status]).toEqual([
        authorization,
        401,
      ]);
    }
  });

  it('no credential at all stays a visitor: 403 unshared, 200 shared', async () => {
    expect((await get(SHUT)).status).toBe(403);
    expect((await get(OPEN)).status).toBe(200);
    // A cookie that is not the session's is no credential either.
    expect((await get(OPEN, { cookie: 'theme=dark' })).status).toBe(200);
  });

  it('a valid session is unchanged', async () => {
    expect((await get(SHUT, { cookie: live })).status).toBe(200);
    expect((await get(OPEN, { cookie: live })).status).toBe(200);
  });
});
