/**
 * A session-only route answers 401 to nobody and 403 to a valid API key.
 *
 * These routes take a signed-in user and nothing else. They answered every
 * request without a session with 401 — a valid key of this tenant included —
 * and the SDK reads every 401 as "the session is gone" and fires
 * `onUnauthorized`, so an SDK client authenticated by key was signed out for
 * touching one. `admin-guard-status.test.ts` pins the same split on the admin
 * routes; this pins it on `guardSession` / `refuseWithoutSession`.
 *
 * No key is let in: the valid key is refused (403), only the status changed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import {
  createKeyCreator,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

/** `stream` opens an SSE response for a session, so the cookie check skips it. */
const ROUTES: Array<[method: string, path: string, stream?: true]> = [
  // Takes a key holding `$rpc` now; this key does not — rpc-api-key.test.ts.
  ['POST', '/api/rpc/no_such_fn'],
  ['GET', '/api/rpc'],
  // Takes a key now; with no `?collection=` it asks for the wildcard stream,
  // tenant admin only, which a key never is — realtime-sse-api-key.test.ts.
  ['GET', '/api/realtime/stream', true],
  ['GET', '/api/realtime/presence/room'],
  ['POST', '/api/realtime/presence/room'],
  ['DELETE', '/api/realtime/presence/room'],
  ['POST', '/api/realtime/broadcast/room'],
  ['GET', '/api/realtime/connections'],
  ['POST', '/api/realtime/publish'],
  ['POST', '/api/sync/pull'],
  // Takes a key holding `$storage` now; this key does not — storage-api-key.test.ts.
  ['GET', '/api/storage'],
  ['GET', '/api/revisions'],
  ['GET', '/api/erd/layout'],
  ['GET', '/api/saved-queries'],
  ['GET', '/api/insights/dashboards'],
  ['GET', '/api/tenants/me'],
  ['GET', '/api/electric/config'],
  ['GET', '/api/notifications'],
  ['GET', '/api/health/version'],
  ['GET', '/api/health/deep'],
  ['GET', '/api/me'],
  ['GET', '/api/extensions'],
  ['GET', '/api/ws/stats'],
];

const STAMP = `sguard-${Date.now()}`;
const KEYS = {
  valid: { raw: generateApiKey(), tenant: '00000000-0000-0000-0000-000000000001', active: true },
  revoked: { raw: generateApiKey(), tenant: '00000000-0000-0000-0000-000000000001', active: false },
  foreign: { raw: generateApiKey(), tenant: '00000000-0000-0000-0000-0000000000fd', active: true },
};

d('session-only routes: 401 for nobody, 403 for a valid API key', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    ({ cookie } = await createMemberSession(app, db));
    for (const [name, k] of Object.entries(KEYS)) {
      await sql`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, tenant_id, created_by)
        VALUES (${`${STAMP}-${name}`}, ${await hashApiKey(k.raw)}, ${k.raw.slice(0, 12)},
                '["*"]'::jsonb, ${k.active}, ${k.tenant}::uuid, ${await createKeyCreator(db)})
      `.execute(db);
    }
  }, 60_000);

  afterAll(async () => {
    if (db) await sql`DELETE FROM zv_api_keys WHERE name LIKE ${`${STAMP}-%`}`.execute(db);
  });

  const send = (method: string, path: string, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(method === 'GET' ? {} : { body: '{}' }),
    });

  for (const [method, path, stream] of ROUTES) {
    it(`${method} ${path}`, async () => {
      expect((await send(method, path)).status).toBe(401);
      // The SDK would sign a key client out on a 401 for a route keys cannot use.
      expect((await send(method, path, { 'X-API-Key': KEYS.valid.raw })).status).toBe(403);
      expect((await send(method, path, { 'X-API-Key': KEYS.revoked.raw })).status).toBe(401);
      expect((await send(method, path, { 'X-API-Key': KEYS.foreign.raw })).status).toBe(401);
      // A session still gets past the gate.
      if (!stream) expect((await send(method, path, { cookie })).status).not.toBe(401);
    });
  }

  // The fail-closed `/ext/*` gate is the same kind of door: a session, never a key.
  it('GET /ext/* (fail-closed extension gate)', async () => {
    const path = '/ext/no-such-ext/anything';
    const anon = await send('GET', path);
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { code: string }).code).toBe('EXT_AUTH_REQUIRED');
    const keyed = await send('GET', path, { 'X-API-Key': KEYS.valid.raw });
    expect(keyed.status).toBe(403);
    expect(((await keyed.json()) as { code: string }).code).toBe('EXT_SESSION_REQUIRED');
    const bearer = await send('GET', path, { Authorization: `Bearer ${KEYS.valid.raw}` });
    expect(bearer.status).toBe(403);
    expect((await send('GET', path, { 'X-API-Key': KEYS.revoked.raw })).status).toBe(401);
    expect((await send('GET', path, { 'X-API-Key': KEYS.foreign.raw })).status).toBe(401);
    expect((await send('GET', path, { cookie })).status).not.toBe(401);
  });

  it('a key sent as a bearer token is refused with 403 too', async () => {
    const res = await send('GET', '/api/storage', { Authorization: `Bearer ${KEYS.valid.raw}` });
    expect(res.status).toBe(403);
  });
});
