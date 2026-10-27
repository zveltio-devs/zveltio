/**
 * An admin write needs one connection.
 *
 * `second-reservation.test.ts` GETs its routes; the writes beside them were never
 * counted. Every Casbin write goes through the adapter on the pool (`_db` in
 * lib/tenancy/permissions.ts), session revocation runs on `poolDb`, and a cold
 * `isGodUser` reads the pool — each a second connection taken while the request
 * held its tenant transaction. So `DB_POOL_MAX` concurrent grants, or user
 * deletions, held every connection and waited for one more until the 35 s
 * acquire deadline. Measured red: 1-7 extra connections per route below, and a
 * burst of 2 x pool `POST /api/permissions/policies` hung.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { _setConnectionTracing, tracedAcquisitionSite } from '../../db/connection-trace.js';
import { invalidateGodCache } from '../../lib/tenancy/index.js';
import {
  createMemberSession,
  createSteppedUpGod,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const S = `awoc${Date.now()}`;

/** Users with no session, to delete. The insert trigger grants their `member` row. */
async function plainUsers(db: Database, n: number): Promise<string[]> {
  const ids = Array.from(
    { length: n },
    (_, i) => `${S}_u${i}_${Math.random().toString(36).slice(2)}`,
  );
  for (const id of ids) {
    await sql`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role)
              VALUES (${id}, ${id}, ${`${id}@test.local`}, true, NOW(), NOW(), 'member')`.execute(
      db,
    );
  }
  return ids;
}

d('an admin write needs one connection (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let stepUp: (action: string) => Promise<Record<string, string>>;

  const send = (method: string, path: string, body?: unknown, headers = {}) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    const booted = await getTestApp();
    db = booted.db;
    ({ app, cookie, stepUp } = await createSteppedUpGod(booted.app, db));
  });

  // Long enough to outlast the 35 s acquire deadline a red run leaves behind.
  afterAll(async () => {
    _setConnectionTracing(false);
    if (!db) return;
    await sql`DELETE FROM "user" WHERE id LIKE ${`${S}%`}`.execute(db);
    await sql`DELETE FROM zvd_permissions WHERE v0 LIKE ${`${S}%`}`.execute(db);
  }, 60_000);

  it('every admin write takes nothing beyond its transaction', async () => {
    const member = await createMemberSession(app, db);
    const [doomed] = await plainUsers(db, 1);
    const seen: string[] = [];
    const call = async (method: string, path: string, body?: unknown, headers = {}) => {
      _setConnectionTracing(true);
      const res = await send(method, path, body, headers);
      _setConnectionTracing(false);
      const extra = res.headers.get('x-zveltio-extra-connections') ?? '0';
      const label = path.replace(member.userId, ':user').replace(doomed!, ':user');
      seen.push(
        `${method} ${label.replace(/[0-9a-f-]{36}/, ':id')} ${res.status} ${extra}${extra === '0' ? '' : ` — ${tracedAcquisitionSite()}`}`,
      );
      return res;
    };
    const role = { userId: member.userId, role: `${S}_role` };
    const policy = { subject: `${S}_role`, resource: `${S}_coll`, action: 'read' };
    await call('POST', '/api/permissions/roles', role);
    await call('DELETE', '/api/permissions/roles', role);
    await call('POST', '/api/permissions/policies', policy);
    await call('DELETE', '/api/permissions/policies', policy);
    // Cold, as the target of an admin action always is: the god check reads it.
    await invalidateGodCache(member.userId);
    await call('PATCH', `/api/users/${member.userId}`, { role: 'member' });
    await invalidateGodCache(member.userId);
    await call(
      'POST',
      `/api/users/${member.userId}/factors/reset`,
      undefined,
      await stepUp(`user.factors.reset:${member.userId}`),
    );
    await call('DELETE', `/api/users/${doomed}`);
    const key = (await (await call('POST', '/api/admin/api-keys', { name: S })).json()) as {
      id: string;
    };
    await call('PATCH', `/api/admin/api-keys/${key.id}`, { name: `${S}b` });
    await call('DELETE', `/api/admin/api-keys/${key.id}`);
    const own = (await (await call('POST', '/api/api-keys', { name: S })).json()) as {
      id: string;
    };
    await call('DELETE', `/api/api-keys/${own.id}`);
    const matrix = (await (await send('GET', '/api/admin/permissions')).json()) as {
      permissions: unknown[];
      version: string;
    };
    await call('POST', '/api/admin/permissions/bulk', {
      permissions: matrix.permissions,
      version: matrix.version,
    });
    await call('POST', '/api/admin/permissions/orphans/prune', {
      rows: [{ ptype: 'g', rule: [`${S}_ghost`, `${S}_role`, '*'] }],
    });
    expect(seen).toEqual([
      'POST /api/permissions/roles 200 0',
      'DELETE /api/permissions/roles 200 0',
      'POST /api/permissions/policies 200 0',
      'DELETE /api/permissions/policies 200 0',
      'PATCH /api/users/:user 200 0',
      'POST /api/users/:user/factors/reset 200 0',
      'DELETE /api/users/:user 200 0',
      'POST /api/admin/api-keys 200 0',
      'PATCH /api/admin/api-keys/:id 200 0',
      'DELETE /api/admin/api-keys/:id 200 0',
      'POST /api/api-keys 200 0',
      'DELETE /api/api-keys/:id 200 0',
      'POST /api/admin/permissions/bulk 200 0',
      'POST /api/admin/permissions/orphans/prune 200 0',
    ]);
  }, 60_000);

  const pool = Number(process.env.DB_POOL_MAX ?? '10');
  const burst = (n: number, one: (i: number) => Response | Promise<Response>) =>
    Promise.race([
      Promise.all(Array.from({ length: n }, async (_, i) => (await one(i)).status)),
      Bun.sleep(15_000).then(() => 'HANG'),
    ]);

  it('a burst of grants at twice the pool size completes', async () => {
    const statuses = await burst(pool * 2, (i) =>
      send('POST', '/api/permissions/policies', {
        subject: `${S}_burst${i}`,
        resource: `${S}_coll`,
        action: 'read',
      }),
    );
    expect(statuses).toEqual(Array.from({ length: pool * 2 }, () => 200));
  }, 60_000);

  it('a burst of user deletions at twice the pool size completes', async () => {
    const ids = await plainUsers(db, pool * 2);
    const statuses = await burst(ids.length, (i) => send('DELETE', `/api/users/${ids[i]}`));
    expect(statuses).toEqual(ids.map(() => 200));
  }, 60_000);
});
