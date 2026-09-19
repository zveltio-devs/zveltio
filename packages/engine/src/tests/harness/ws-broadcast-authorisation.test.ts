/**
 * The WebSocket fan-out delivers what SSE refuses to.
 *
 * `routes/realtime.ts` resolves three layers when a stream opens — the
 * collection permission, the row policies from `zv_rls_policies`, and column
 * permissions — and applies the last two to every event it delivers. The
 * WebSocket path beside it checks only the collection permission, at subscribe
 * time, and `broadcastEvent` then sends the whole record to every subscriber.
 *
 * Same write, same user, two doors, two answers.
 *
 * The suite drives a NON-god session on purpose: god holds
 * `data:view_all_columns` and bypasses row policies, so a god socket cannot
 * observe either restriction.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { broadcastEvent, websocketHandler, _wsPermCacheForTests } from '../../routes/ws.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `wsauth_${Date.now()}`;

/** A socket that records what the engine sent it. */
function fakeSocket(id: string) {
  const sent: string[] = [];
  return {
    ws: {
      data: { id, userId: MEMBER.id, tenantId: null, authType: 'session' },
      send: (p: string) => sent.push(p),
      close: () => {},
    },
    sent,
  };
}

/** Filled in `beforeAll`; `fakeSocket` reads it when a socket opens. */
const MEMBER = { id: '' };

d('WebSocket fan-out applies the same authorisation as SSE', () => {
  let app: Hono;
  let db: Database;
  let member: { cookie: string; userId: string };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: false, unique: false, indexed: false },
        { name: 'salary', type: 'text', required: false, unique: false, indexed: false },
        { name: 'owner', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    await db
      .insertInto('zvd_column_permissions')
      .values({
        collection_name: COLLECTION,
        column_name: 'salary',
        role: 'member',
        can_read: false,
        can_write: false,
      } as never)
      .execute();
    member = await createMemberSession(app, db, {
      role: 'member',
      grants: [{ collection: COLLECTION, actions: ['read', 'list'] }],
    });
    MEMBER.id = member.userId;
    // A row policy of the ordinary shape: a member sees only its own rows.
    await sql
      .raw(
        `INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source, is_enabled)
         VALUES ('${COLLECTION}', 'member', 'owner', 'eq', 'user_id', TRUE)`,
      )
      .execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    const { connections } = _wsPermCacheForTests();
    connections.delete('ws_probe');
    await sql
      .raw(`DELETE FROM zvd_rls_policies WHERE collection = '${COLLECTION}'`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_column_permissions')
      .where('collection_name', '=', COLLECTION)
      .execute()
      .catch(() => {});
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('GET /api/data redacts the column (the behaviour being matched)', async () => {
    await sql
      .raw(`INSERT INTO "zvd_${COLLECTION}" (title, salary) VALUES ('a','SECRET-WS')`)
      .execute(db);
    const res = await app.request(`/api/data/${COLLECTION}`, {
      headers: { cookie: member.cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"title":"a"');
    expect(body).not.toContain('SECRET-WS');
  });

  it('a subscribed socket does not receive a column its owner cannot read', async () => {
    const probe = fakeSocket('ws_probe');
    // Drive the real handlers, not a hand-built connection: `open` + a
    // `subscribe` frame is what a client does, and it is where the permission
    // check and the authorisation lookup live.
    websocketHandler.open(probe.ws as never);
    await websocketHandler.message(
      probe.ws as never,
      JSON.stringify({ type: 'subscribe', collections: [COLLECTION] }),
    );
    expect(probe.sent.join('\n')).toContain('"type":"subscribed"');
    expect(probe.sent.join('\n')).toContain(COLLECTION);

    probe.sent.length = 0;
    broadcastEvent(
      COLLECTION,
      'insert',
      // `owner` is the member's own: the row policy below must not be what keeps
      // the column out of the payload.
      { id: 'r1', title: 'a', salary: 'SECRET-WS', owner: MEMBER.id },
      null,
    );

    // The socket must hear the event — otherwise the assertion below passes
    // because nothing was delivered at all.
    expect(probe.sent.length).toBe(1);
    expect(probe.sent[0]).toContain('"title":"a"');
    expect(probe.sent[0]).not.toContain('SECRET-WS');
  });

  it('a subscribed socket does not receive a row its owner cannot read', async () => {
    const probe = fakeSocket('ws_probe_rls');
    websocketHandler.open(probe.ws as never);
    await websocketHandler.message(
      probe.ws as never,
      JSON.stringify({ type: 'subscribe', collections: [COLLECTION] }),
    );
    probe.sent.length = 0;

    // Someone else's row: the policy above restricts a member to `owner = <id>`.
    broadcastEvent(
      COLLECTION,
      'insert',
      { id: 'r2', title: 'theirs', owner: 'somebody-else' },
      null,
    );
    expect(probe.sent.length).toBe(0);

    // Its own row still arrives — the guard must filter, not mute the stream.
    broadcastEvent(COLLECTION, 'insert', { id: 'r3', title: 'mine', owner: MEMBER.id }, null);
    expect(probe.sent.length).toBe(1);
    expect(probe.sent[0]).toContain('"title":"mine"');
  });
});
