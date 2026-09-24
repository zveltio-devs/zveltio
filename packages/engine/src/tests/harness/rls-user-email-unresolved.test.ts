/**
 * A `user_email` row rule vanished for every caller that carried no email.
 *
 * `resolveValue` answered `user.email ?? null`, and `getRlsFilters` reads null
 * as "cannot resolve — skip this policy". The generated Postgres policy was
 * written to agree, standing the rule down on an empty `zveltio.user_email`.
 * Two enforcers, one decision, and the decision was fail-open.
 *
 * Callers with no email were not an edge case:
 *   - every API key (a key has no email, and new keys are subject to RLS
 *     since migration 032), on REST — both enforcers stood down;
 *   - every SESSION on the WebSocket and the SSE stream, which built the
 *     user as `{ id }` / `{ id, role }` and filter in memory, with no
 *     database policy behind them at all.
 *
 * So `owner_email eq user_email` — "a member sees only its own rows" — held on
 * `GET /api/data` and delivered everyone's rows over both realtime doors, and
 * to any key.
 *
 * `user_role` had the same defect and was repaired by resolving an absent value
 * to `''`, which is what the database compares an unset setting against. This
 * is the same repair for the one source that was left.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { dispatchToWs } from '../../lib/runtime/realtime-bus.js';
import { _sseConnectionsForTests } from '../../routes/realtime.js';
import { broadcastEvent, websocketHandler, _wsPermCacheForTests } from '../../routes/ws.js';
import {
  createGodSession,
  createMemberSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `rlsmail_${Date.now()}`;
const OTHER = 'someone-else@example.test';

d('a user_email row rule is not dropped for a caller without an email', () => {
  let app: Hono;
  let db: Database;
  let member: { cookie: string; userId: string; email: string };
  let rawKey = '';
  let keyId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: false, unique: false, indexed: false },
        { name: 'owner_email', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    member = await createMemberSession(app, db, {
      role: 'member',
      grants: [{ collection: COLLECTION, actions: ['read', 'list'] }],
    });
    await sql`
      INSERT INTO ${sql.table(`zvd_${COLLECTION}`)} (title, owner_email)
      VALUES ('mine', ${member.email}), ('theirs', ${OTHER})
    `.execute(db);
    // Straight into the table and then through the route's own rebuild, so the
    // database policy is the one the engine would generate.
    await sql`
      INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source, is_enabled)
      VALUES (${COLLECTION}, '*', 'owner_email', 'eq', 'user_email', TRUE)
    `.execute(db);
    const { invalidateRlsCache } = await import('../../lib/tenancy/rls.js');
    await invalidateRlsCache(COLLECTION);

    const god = await createGodSession(app, db);
    const keyRes = await app.request('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({
        name: `Harness rls email key ${Date.now()}`,
        scopes: [{ collection: COLLECTION, actions: ['read'] }],
      }),
    });
    expect(keyRes.status).toBe(200);
    ({ id: keyId, key: rawKey } = (await keyRes.json()) as { id: string; key: string });
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of ['ws_rls_email', 'ws_rls_email_key']) {
      _wsPermCacheForTests().connections.delete(id);
    }
    if (keyId) {
      await db
        .deleteFrom('zv_api_key_access_log')
        .where('api_key_id', '=', keyId)
        .execute()
        .catch(() => {});
      await db
        .deleteFrom('zv_api_keys')
        .where('id', '=', keyId)
        .execute()
        .catch(() => {});
    }
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

  it('REST, session: the rule holds (the behaviour being matched)', async () => {
    const res = await app.request(`/api/data/${COLLECTION}`, {
      headers: { cookie: member.cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"mine"');
    expect(body).not.toContain('"theirs"');
  });

  it('REST, API key: a key has no email, so it matches no owner', async () => {
    const res = await app.request(`/api/data/${COLLECTION}`, {
      headers: { 'X-API-Key': rawKey },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('"theirs"');
    expect(body).not.toContain('"mine"');
  });

  it('SSE, session: another owner’s row is not delivered, its own is', async () => {
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

    const send = (id: string, title: string, owner: string) =>
      dispatchToWs({
        originId: 'another-replica',
        event: 'record.created',
        collection: COLLECTION,
        record_id: id,
        data: { id, title, owner_email: owner },
        timestamp: new Date().toISOString(),
        tenantId: sub.tenantId,
      });
    send('s1', 'sse-theirs', OTHER);
    send('s2', 'sse-mine', member.email);

    const all = delivered.join('\n');
    expect(all).not.toContain('sse-theirs');
    expect(all).toContain('sse-mine');
    await reader.cancel().catch(() => {});
  });

  /** Opens a socket through the real `/api/ws` upgrade and subscribes it. */
  async function subscribedSocket(headers: Record<string, string>, id: string) {
    let data: Record<string, unknown> | undefined;
    const server = {
      upgrade: (_req: Request, opts: { data: Record<string, unknown> }) => {
        data = opts.data;
        return true;
      },
    };
    await app.request('/api/ws', { headers }, { server });
    const sent: string[] = [];
    const ws = { data: { ...data, id }, send: (p: string) => sent.push(p), close: () => {} };
    websocketHandler.open(ws as never);
    await websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', collections: [COLLECTION] }),
    );
    expect(sent.join('\n')).toContain('"type":"subscribed"');
    sent.length = 0;
    const tenantId = (data?.tenantId as string | null) ?? null;
    const send = (rid: string, title: string, owner: string) =>
      broadcastEvent(COLLECTION, 'insert', { id: rid, title, owner_email: owner }, tenantId);
    return { sent, send, authType: data?.authType };
  }

  it('WebSocket, session: another owner’s row is not delivered, its own is', async () => {
    const sock = await subscribedSocket({ cookie: member.cookie }, 'ws_rls_email');
    expect(sock.authType).toBe('session');
    sock.send('w1', 'ws-theirs', OTHER);
    sock.send('w2', 'ws-mine', member.email);
    const all = sock.sent.join('\n');
    expect(all).not.toContain('ws-theirs');
    expect(all).toContain('ws-mine');
  });

  it('WebSocket, API key: no row is delivered — there is no database policy behind this door', async () => {
    const sock = await subscribedSocket({ 'X-API-Key': rawKey }, 'ws_rls_email_key');
    expect(sock.authType).toBe('api_key');
    sock.send('k1', 'key-theirs', OTHER);
    expect(sock.sent.join('\n')).not.toContain('key-theirs');
  });
});
