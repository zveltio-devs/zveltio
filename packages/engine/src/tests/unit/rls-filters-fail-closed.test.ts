/**
 * A row-policy lookup that FAILS must not read as "no row policies".
 *
 * `getRlsFilters` answers `[]` for "nothing restricts this caller". The SSE
 * stream, the WebSocket fan-out and `?expand=` each caught its rejection as
 * `[]` too, so a database error while loading the policies — a pool timeout, a
 * statement timeout, a failover — delivered or hydrated every row the caller's
 * rules would have hidden. The REST list path lets the same error through
 * (500), which is the behaviour these three now match.
 *
 * The failure here is real, not mocked: the policy query itself rejects.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { auth, initAuth } from '../../lib/auth.js';
import { _setCacheForTests } from '../../lib/runtime/cache.js';
import { applyExpand } from '../../lib/data/shape.js';
import { initPermissions, initRls } from '../../lib/tenancy/index.js';
import {
  _sseConnectionsForTests,
  broadcastDataEvent,
  realtimeRoutes,
} from '../../routes/realtime.js';
import { broadcastEvent, websocketHandler, wsRoutes } from '../../routes/ws.js';
import { CannedDb } from './fixtures/canned-db.js';

const USER = { id: 'u-reader', email: 'reader@example.test' };
const HIDDEN = 'row-the-policy-hides';

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

/** `u-reader` may read `contacts`; nothing lifts its row policies. */
function permissionsDb(): CannedDb {
  const db = new CannedDb();
  db.when(/FROM zvd_permissions/i, [
    { ptype: 'p', v0: 'reader', v1: '*', v2: 'contacts', v3: 'read', v4: null, v5: null },
    { ptype: 'g', v0: USER.id, v1: 'reader', v2: '*', v3: null, v4: null, v5: null },
  ]);
  db.when(/SELECT role FROM "user"/i, [{ role: 'member' }]);
  return db;
}

/** Every other query answers; loading the row policies does not. */
function failingDb(): CannedDb {
  const db = permissionsDb();
  db.fail(/zvd_rls_policies/i, new Error('canceling statement due to statement timeout'));
  db.when(/select \* from "zvd_collections" where "name" = /i, [
    { name: 'contacts', fields: JSON.stringify([{ name: 'title', type: 'text' }]) },
  ]);
  db.when(/SELECT \* FROM "zvd_contacts"/i, [{ id: 'c-1', title: HIDDEN }]);
  return db;
}

let db: CannedDb;

beforeAll(async () => {
  process.env.BETTER_AUTH_SECRET ??= 'unit-test-secret-minimum-32-characters-xx';
  _setCacheForTests(null);
  const seed = permissionsDb();
  await initAuth(asDb(seed));
  await initPermissions(asDb(seed));
  db = failingDb();
  initRls(asDb(db));
});

afterAll(async () => {
  const empty = asDb(new CannedDb());
  await initPermissions(empty);
  initRls(empty);
});

describe('a failed row-policy lookup fails closed', () => {
  it('?expand= does not hydrate the target rows', async () => {
    const records = [{ id: 'r-1', contact: 'c-1' }] as Record<string, unknown>[];
    const plan = [{ field: 'contact', targetCollection: 'contacts', targetTable: 'zvd_contacts' }];
    const run = applyExpand(asDb(db), records as never, plan, 'member', USER as never);

    await expect(run).rejects.toThrow(/statement timeout/);
    expect(records[0]).not.toHaveProperty('contact_expanded');
  });

  it('SSE: the stream is refused rather than opened unfiltered', async () => {
    const spy = spyOn(auth.api, 'getSession').mockResolvedValue({ user: USER } as never);
    try {
      const app = new Hono().route('/', realtimeRoutes(asDb(db), auth));
      const res = await app.request('/stream?collection=contacts');

      const subs = [...(_sseConnectionsForTests().get(USER.id) ?? [])];
      const delivered: string[] = [];
      for (const sub of subs) {
        sub.stream.writeSSE = ((msg: { data: string }) => {
          delivered.push(msg.data);
          return Promise.resolve();
        }) as typeof sub.stream.writeSSE;
      }
      broadcastDataEvent('contacts', 'insert', { id: 'c-1', title: HIDDEN }, null);
      await res.body?.cancel().catch(() => {});

      expect(delivered.join('\n')).not.toContain(HIDDEN);
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });

  it('WebSocket: the subscription is denied rather than granted unfiltered', async () => {
    wsRoutes(asDb(db), auth);
    const sent: string[] = [];
    const ws = {
      data: { id: 'ws_rls_fail', userId: USER.id, user: USER, tenantId: null, authType: 'session' },
      send: (p: string) => sent.push(p),
      close: () => {},
    };
    websocketHandler.open(ws as never);
    await websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', collections: ['contacts'] }),
    );
    broadcastEvent('contacts', 'insert', { id: 'c-1', title: HIDDEN }, null);
    websocketHandler.close(ws as never);

    const all = sent.join('\n');
    expect(all).not.toContain(HIDDEN);
    expect(all).toContain('"denied":["contacts"]');
  });
});
