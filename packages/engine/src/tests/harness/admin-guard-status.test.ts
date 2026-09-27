/**
 * An admin-only route answers 401 to nobody and 403 to somebody.
 *
 * Most admin route modules folded "no session" and "signed in, not an admin"
 * into one `null` and answered both with 401. The SDK reads every 401 as "your
 * session is gone" and fires `onUnauthorized`, so a member who opened an admin
 * page was treated as signed out. `/api/settings` already told the two apart;
 * this pins the same split on every guard that did not.
 *
 * An API key is somebody too. A valid key that is not an admin is refused with
 * 403; only a key that authenticates nobody here — unknown, revoked, or another
 * tenant's — gets 401.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const ROUTES: Array<[method: string, path: string]> = [
  ['GET', '/api/users'],
  ['GET', '/api/admin/status'],
  ['GET', '/api/api-keys'],
  ['GET', '/api/collections'],
  ['GET', '/api/relations'],
  ['GET', '/api/webhooks'],
  ['GET', '/api/flows'],
  ['GET', '/api/permissions'],
  ['GET', '/api/admin/rls'],
  ['GET', '/api/marketplace'],
  ['GET', '/api/admin/license/history'],
  ['POST', '/api/marketplace/no-such-ext/install'],
  ['POST', '/api/marketplace/no-such-ext/deactivate'],
  ['GET', '/api/settings'],
  ['GET', '/api/backup'],
  ['GET', '/api/schema/branches'],
  ['GET', '/api/templates'],
  ['POST', '/api/admin/sql'],
];

/** The routes behind `guardAdmin` — the ones a key's status code is pinned on. */
const KEY_ROUTES = ROUTES.filter(([, path]) => path !== '/api/api-keys');

const STAMP = `guard-${Date.now()}`;
const KEYS = {
  valid: { raw: generateApiKey(), tenant: '00000000-0000-0000-0000-000000000001', active: true },
  revoked: { raw: generateApiKey(), tenant: '00000000-0000-0000-0000-000000000001', active: false },
  foreign: { raw: generateApiKey(), tenant: '00000000-0000-0000-0000-0000000000fd', active: true },
};

d('admin guards: 401 without a session, 403 for a signed-in non-admin', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    ({ cookie } = await createMemberSession(app, db));
    for (const [name, k] of Object.entries(KEYS)) {
      await sql`
        INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, tenant_id)
        VALUES (${`${STAMP}-${name}`}, ${await hashApiKey(k.raw)}, ${k.raw.slice(0, 12)},
                '["*"]'::jsonb, ${k.active}, ${k.tenant}::uuid)
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

  for (const [method, path] of ROUTES) {
    it(`${method} ${path}`, async () => {
      expect((await send(method, path)).status).toBe(401);
      expect((await send(method, path, { cookie })).status).toBe(403);
    });
  }

  for (const [method, path] of KEY_ROUTES) {
    it(`${method} ${path} with an API key`, async () => {
      // The SDK would sign a key client out on a 401 it got for lacking a role.
      expect((await send(method, path, { 'X-API-Key': KEYS.valid.raw })).status).toBe(403);
      expect((await send(method, path, { 'X-API-Key': KEYS.revoked.raw })).status).toBe(401);
      expect((await send(method, path, { 'X-API-Key': KEYS.foreign.raw })).status).toBe(401);
    });
  }
});
