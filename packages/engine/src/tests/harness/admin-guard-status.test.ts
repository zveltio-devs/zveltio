/**
 * An admin-only route answers 401 to nobody and 403 to somebody.
 *
 * Most admin route modules folded "no session" and "signed in, not an admin"
 * into one `null` and answered both with 401. The SDK reads every 401 as "your
 * session is gone" and fires `onUnauthorized`, so a member who opened an admin
 * page was treated as signed out. `/api/settings` already told the two apart;
 * this pins the same split on every guard that did not.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
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
];

d('admin guards: 401 without a session, 403 for a signed-in non-admin', () => {
  let app: Hono;
  let cookie = '';

  beforeAll(async () => {
    const t = await getTestApp();
    app = t.app;
    ({ cookie } = await createMemberSession(app, t.db));
  }, 60_000);

  const send = (method: string, path: string, withCookie: boolean) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(withCookie ? { cookie } : {}) },
      ...(method === 'GET' ? {} : { body: '{}' }),
    });

  for (const [method, path] of ROUTES) {
    it(`${method} ${path}`, async () => {
      expect((await send(method, path, false)).status).toBe(401);
      expect((await send(method, path, true)).status).toBe(403);
    });
  }
});
