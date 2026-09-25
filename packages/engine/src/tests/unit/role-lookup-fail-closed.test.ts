/**
 * A role lookup that FAILS must not read as some other role.
 *
 * Column rules and row rules are restrictions keyed BY role: a rule for
 * `member` hides a column from members and from nobody else. So there is no
 * "least-privileged" role to fall back to — `resolveUserRole` answered
 * `'public'` when `SELECT role FROM "user"` failed, the SSE stream and the
 * WebSocket subscribe path caught a rejection as `'user'`, and either way the
 * `member` rule stopped matching and the column it hides was delivered.
 *
 * The failure is real, not mocked: the role query itself rejects.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { auth, initAuth } from '../../lib/auth.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import {
  clearLocalPermissionCache,
  initPermissions,
  initRls,
  resolveUserRole,
} from '../../lib/tenancy/index.js';
import {
  _sseConnectionsForTests,
  broadcastDataEvent,
  realtimeRoutes,
} from '../../routes/realtime.js';
import { broadcastEvent, websocketHandler, wsRoutes } from '../../routes/ws.js';
import { CannedDb } from './fixtures/canned-db.js';

const USER = { id: 'u-member', email: 'member@example.test' };
const SECRET = 'column-the-member-rule-hides';

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

/** `u-member` may read `contacts`; a `member` column rule hides `salary`. */
function seedDb(): CannedDb {
  const db = new CannedDb();
  db.when(/FROM zvd_permissions/i, [
    { ptype: 'p', v0: 'reader', v1: '*', v2: 'contacts', v3: 'read', v4: null, v5: null },
    { ptype: 'g', v0: USER.id, v1: 'reader', v2: '*', v3: null, v4: null, v5: null },
  ]);
  db.when(/SELECT role FROM "user"/i, [{ role: 'member' }]);
  db.when(/from "zvd_column_permissions"/i, (q) =>
    q.parameters.includes('member')
      ? [{ column_name: 'salary', can_read: false, can_write: false }]
      : [],
  );
  return db;
}

let db: CannedDb;

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ??= 'unit-test-secret-minimum-32-characters-xx';
  _setCacheForTests(null);
  await initAuth(asDb(seedDb()));
  db = seedDb();
  db.fail(/SELECT role FROM "user"/i, new Error('timeout exceeded when trying to connect'));
  await initPermissions(asDb(db));
  initRls(asDb(db));
  clearLocalPermissionCache();
});

afterAll(async () => {
  const empty = asDb(new CannedDb());
  await initPermissions(empty);
  initRls(empty);
  clearLocalPermissionCache();
});

describe('a failed role lookup fails closed', () => {
  it('resolveUserRole rejects instead of inventing a role', async () => {
    await expect(resolveUserRole({ id: USER.id })).rejects.toThrow(/timeout/);
  });

  it('SSE: the stream is refused rather than opened as another role', async () => {
    const spy = spyOn(auth.api, 'getSession').mockResolvedValue({ user: USER } as never);
    try {
      const app = new Hono().route('/', realtimeRoutes(asDb(db), auth));
      const res = await app.request('/stream?collection=contacts');

      const delivered: string[] = [];
      for (const sub of _sseConnectionsForTests().get(USER.id) ?? []) {
        sub.stream.writeSSE = ((msg: { data: string }) => {
          delivered.push(msg.data);
          return Promise.resolve();
        }) as typeof sub.stream.writeSSE;
      }
      broadcastDataEvent('contacts', 'insert', { id: 'c-1', salary: SECRET }, null);
      await res.body?.cancel().catch(() => {});

      expect(delivered.join('\n')).not.toContain(SECRET);
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });

  it('WebSocket: the subscription is denied rather than granted as another role', async () => {
    wsRoutes(asDb(db), auth);
    const sent: string[] = [];
    const ws = {
      data: {
        id: 'ws_role_fail',
        userId: USER.id,
        user: USER,
        tenantId: null,
        authType: 'session',
      },
      send: (p: string) => sent.push(p),
      close: () => {},
    };
    websocketHandler.open(ws as never);
    await websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', collections: ['contacts'] }),
    );
    broadcastEvent('contacts', 'insert', { id: 'c-1', salary: SECRET }, null);
    websocketHandler.close(ws as never);

    const all = sent.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).toContain('"denied":["contacts"]');
  });
});

describe('a healthy role lookup', () => {
  beforeAll(async () => {
    db = seedDb();
    await initPermissions(asDb(db));
    initRls(asDb(db));
    clearLocalPermissionCache();
  });

  // The stream ran as `session.user.role ?? 'user'` — never populated, so
  // always `'user'` — and a `member` rule did not apply even with no failure.
  it('SSE: a member column rule masks the column', async () => {
    const spy = spyOn(auth.api, 'getSession').mockResolvedValue({ user: USER } as never);
    try {
      const app = new Hono().route('/', realtimeRoutes(asDb(db), auth));
      const res = await app.request('/stream?collection=contacts');

      const delivered: string[] = [];
      for (const sub of _sseConnectionsForTests().get(USER.id) ?? []) {
        sub.stream.writeSSE = ((msg: { data: string }) => {
          delivered.push(msg.data);
          return Promise.resolve();
        }) as typeof sub.stream.writeSSE;
      }
      broadcastDataEvent('contacts', 'insert', { id: 'c-2', salary: SECRET }, null);
      await res.body?.cancel().catch(() => {});

      expect(res.status).toBe(200);
      expect(delivered.join('\n')).toContain('"c-2"');
      expect(delivered.join('\n')).not.toContain(SECRET);
    } finally {
      spy.mockRestore();
    }
  });
});
