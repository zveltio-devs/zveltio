/**
 * A row rule whose value source the engine does not know hid NOTHING.
 *
 * `resolveValue` answered null for any source outside user_id / user_email /
 * user_role / static:, `getRlsFilters` read null as "skip this policy", and the
 * generated Postgres policy left the rule out as well. Both enforcers stood
 * down, so the rule was listed as enabled and every row was visible.
 *
 * The save route refuses such a source now, which is why this is reachable only
 * through a row the route never saw: one stored before the refine existed (the
 * route's own comment names `user.id`, a dot for an underscore, as having been
 * stored happily), or written straight into the table. Such a row is exactly
 * where a security filter must not quietly disappear.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { dispatchToWs } from '../../lib/runtime/realtime-bus.js';
import { _sseConnectionsForTests } from '../../routes/realtime.js';
import { broadcastEvent, websocketHandler, _wsPermCacheForTests } from '../../routes/ws.js';
import { createMemberSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `rlsunknown_${Date.now()}`;

d('a row rule with an unknown value source fails closed', () => {
  let app: Hono;
  let db: Database;
  let member: { cookie: string; userId: string; email: string };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: false, unique: false, indexed: false },
        { name: 'owner', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    member = await createMemberSession(app, db, {
      role: 'member',
      grants: [{ collection: COLLECTION, actions: ['read', 'list'] }],
    });
    await sql`
      INSERT INTO ${sql.table(`zvd_${COLLECTION}`)} (title, owner)
      VALUES ('mine', ${member.userId}), ('theirs', 'someone-else')
    `.execute(db);
    // The legacy typo, straight into the table and then through the rebuild the
    // routes use, so the database policy is the one the engine would generate.
    await sql`
      INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source, is_enabled)
      VALUES (${COLLECTION}, '*', 'owner', 'eq', 'user.id', TRUE)
    `.execute(db);
    const { invalidateRlsCache } = await import('../../lib/tenancy/rls.js');
    await invalidateRlsCache(COLLECTION);
  });

  afterAll(async () => {
    if (!db) return;
    _wsPermCacheForTests().connections.delete('ws_rls_unknown');
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${COLLECTION}`
      .execute(db)
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

  it('REST list: no row is returned', async () => {
    const res = await app.request(`/api/data/${COLLECTION}`, {
      headers: { cookie: member.cookie },
    });
    // 200 and empty, not an error: the engine's own filter is a deliberate
    // `false`, and the database policy agrees with it.
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('"theirs"');
    expect(body).not.toContain('"mine"');
  });

  it('SSE: no row is delivered', async () => {
    const res = await app.request(`/api/realtime/stream?collection=${COLLECTION}`, {
      headers: { cookie: member.cookie },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    const sub = [...(_sseConnectionsForTests().get(member.userId) ?? [])][0]!;
    const delivered: string[] = [];
    sub.stream.writeSSE = ((msg: { data: string }) => {
      delivered.push(msg.data);
      return Promise.resolve();
    }) as typeof sub.stream.writeSSE;
    dispatchToWs({
      originId: 'another-replica',
      event: 'record.created',
      collection: COLLECTION,
      record_id: 's1',
      data: { id: 's1', title: 'sse-theirs', owner: 'someone-else' },
      timestamp: new Date().toISOString(),
      tenantId: sub.tenantId,
    });
    expect(delivered.join('\n')).not.toContain('sse-theirs');
    await reader.cancel().catch(() => {});
  });

  it('WebSocket: no row is delivered', async () => {
    let data: Record<string, unknown> | undefined;
    const server = {
      upgrade: (_req: Request, opts: { data: Record<string, unknown> }) => {
        data = opts.data;
        return true;
      },
    };
    await app.request('/api/ws', { headers: { cookie: member.cookie } }, { server });
    const sent: string[] = [];
    const ws = {
      data: { ...data, id: 'ws_rls_unknown' },
      send: (p: string) => sent.push(p),
      close: () => {},
    };
    websocketHandler.open(ws as never);
    await websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', collections: [COLLECTION] }),
    );
    expect(sent.join('\n')).toContain('"type":"subscribed"');
    sent.length = 0;
    broadcastEvent(
      COLLECTION,
      'insert',
      { id: 'w1', title: 'ws-theirs', owner: 'someone-else' },
      (data?.tenantId as string | null) ?? null,
    );
    expect(sent.join('\n')).not.toContain('ws-theirs');
  });
});
