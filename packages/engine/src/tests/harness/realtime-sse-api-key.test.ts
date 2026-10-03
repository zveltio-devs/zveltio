/**
 * An API key on the SSE data stream, and a key asking who it is.
 *
 * `GET /api/realtime/stream` took a session only, so a program holding a key
 * could subscribe over the WebSocket and not over SSE. It now authenticates as
 * the upgrade does (`realtimeIdentity`): the collection gate is `checkAccess`
 * (the key's scopes), row rules apply unless the key is exempt, and the sweep
 * re-asks the key — a revoked key's stream ends as its sockets close.
 *
 * `GET /api/api-keys/self` answers the presenting key's own record.
 *
 * Asserts on the subscription registry and on the body ending, not on frames
 * read after the first flush — see `_sseConnectionsForTests`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { generateApiKey, hashApiKey } from '../../lib/security/index.js';
import { __sweepIdle, revalidateSockets } from '../../lib/tenancy/index.js';
import { _sseConnectionsForTests, broadcastDataEvent } from '../../routes/realtime.js';
import {
  createKeyCreator,
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const SCOPED = `ssekey_ok_${STAMP}`;
const UNSCOPED = `ssekey_no_${STAMP}`;
const FOREIGN_TENANT = '00000000-0000-0000-0000-0000000000fd';

d('SSE stream with an API key', () => {
  let app: Hono;
  let db: Database;
  let god: string;
  const keyIds: string[] = [];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    for (const name of [SCOPED, UNSCOPED]) {
      await DDLManager.createCollection(db, {
        name,
        fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
      } as never);
    }
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zv_api_keys WHERE name LIKE ${`ssekey-${STAMP}-%`}`.execute(db);
    if (keyIds.length > 0) await db.deleteFrom('zv_api_keys').where('id', 'in', keyIds).execute();
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${SCOPED}`.execute(db);
    for (const name of [SCOPED, UNSCOPED]) await dropTestCollection(db, name).catch(() => {});
  });

  async function createKey(opts: { rls_bypass?: boolean } = {}) {
    const res = await app.request('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({
        name: `ssekey-${STAMP}-${keyIds.length}`,
        scopes: [{ collection: SCOPED, actions: ['read'] }],
        ...opts,
      }),
    });
    expect(res.status).toBe(200);
    const key = (await res.json()) as { id: string; key: string; key_prefix: string };
    keyIds.push(key.id);
    return key;
  }

  const stream = (query: string, headers: Record<string, string>) =>
    app.request(`/api/realtime/stream?${query}`, { headers });

  /** Open a key stream on SCOPED and spy on what it is sent. */
  async function openStream(key: { id: string; key: string }) {
    const res = await stream(`collection=${SCOPED},${UNSCOPED}`, { 'X-API-Key': key.key });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const connected = JSON.parse(/data: (.*)/.exec(first)![1]!) as {
      userId: string;
      collections: string[];
      denied: string[];
    };
    const principal = `apikey:${key.id}`;
    const sub = [..._sseConnectionsForTests().get(principal)!][0]!;
    const delivered: string[] = [];
    const realWrite = sub.stream.writeSSE.bind(sub.stream);
    sub.stream.writeSSE = (msg: { data: string; event?: string }) => {
      delivered.push(msg.data);
      return realWrite(msg);
    };
    const send = (collection: string, title: string) =>
      broadcastDataEvent(collection, 'insert', { id: title, title }, sub.tenantId);
    const isOpen = () => _sseConnectionsForTests().has(principal);
    return { reader, connected, delivered, send, isOpen };
  }

  async function expectEnded(s: Awaited<ReturnType<typeof openStream>>) {
    for (let i = 0; i < 150 && s.isOpen(); i++) await Bun.sleep(20);
    await __sweepIdle();
    expect(s.isOpen()).toBe(false);
    let done = false;
    for (let i = 0; i < 10 && !done; i++) done = (await s.reader.read()).done;
    expect(done).toBe(true);
  }

  it('opens as the key, streams its scoped collection and denies the other', async () => {
    const key = await createKey({ rls_bypass: true });
    const s = await openStream(key);
    expect(s.connected.userId).toBe(`apikey:${key.id}`);
    expect(s.connected.collections).toEqual([SCOPED]);
    expect(s.connected.denied).toEqual([UNSCOPED]);
    s.send(SCOPED, 'in-scope');
    s.send(UNSCOPED, 'out-of-scope');
    expect(s.delivered.join('\n')).toContain('in-scope');
    expect(s.delivered.join('\n')).not.toContain('out-of-scope');
    await s.reader.cancel();
  });

  it('403 when the key reads none of the collections, and on the wildcard and non-data channels', async () => {
    const { key } = await createKey();
    const none = await stream(`collection=${UNSCOPED}`, { 'X-API-Key': key });
    expect(none.status).toBe(403);
    const body = (await none.json()) as { detail: string; errors: { denied: string[] } };
    expect(body.detail).toContain('No read permission');
    expect(body.errors.denied).toEqual([UNSCOPED]);
    // The wildcard stream and non-data channels are tenant admin only; a key is none.
    expect((await stream('', { 'X-API-Key': key })).status).toBe(403);
    const presence = await stream(`collection=${SCOPED}&channel=presence:room`, {
      'X-API-Key': key,
    });
    expect(presence.status).toBe(200);
    const first = new TextDecoder().decode((await presence.body!.getReader().read()).value);
    const connected = JSON.parse(/data: (.*)/.exec(first)![1]!) as { denied: string[] };
    expect(connected.denied).toEqual(['zveltio:presence:room']);
    await presence.body!.cancel().catch(() => {});
  });

  it('applies row rules to a key that is not exempt from them', async () => {
    const res = await app.request('/api/admin/rls', {
      method: 'POST',
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify({
        collection: SCOPED,
        role: 'api_key',
        filter_field: 'title',
        filter_op: 'eq',
        filter_value_source: 'static:visible',
      }),
    });
    expect(res.status).toBeLessThan(300);
    const bound = await openStream(await createKey());
    const exempt = await openStream(await createKey({ rls_bypass: true }));
    for (const s of [bound, exempt]) {
      s.send(SCOPED, 'visible');
      s.send(SCOPED, 'hidden-row');
    }
    expect(bound.delivered.join('\n')).toContain('visible');
    expect(bound.delivered.join('\n')).not.toContain('hidden-row');
    expect(exempt.delivered.join('\n')).toContain('hidden-row');
    await bound.reader.cancel();
    await exempt.reader.cancel();
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${SCOPED}`.execute(db);
  });

  it('ends the stream when the key is revoked', async () => {
    const key = await createKey({ rls_bypass: true });
    const s = await openStream(key);
    const res = await app.request(`/api/api-keys/${key.id}`, {
      method: 'DELETE',
      headers: { cookie: god },
    });
    expect(res.status).toBe(200);
    await expectEnded(s);
    s.delivered.length = 0;
    s.send(SCOPED, 'after-revoke');
    expect(s.delivered.join('')).not.toContain('after-revoke');
    // Its reconnect meets the 401.
    expect((await stream(`collection=${SCOPED}`, { 'X-API-Key': key.key })).status).toBe(401);
  });

  // Scopes written as SQL, not through PATCH /api/admin/api-keys/:id: that
  // route stores them as a jsonb string today, which reads as deny-all and would
  // end the stream whatever the recheck did.
  it('re-reads a key whose scopes changed: kept while it still reads, ended once it does not', async () => {
    const key = await createKey({ rls_bypass: true });
    const s = await openStream(key);
    const setScopes = async (scopes: unknown) => {
      await sql`UPDATE zv_api_keys SET scopes = ${JSON.stringify(scopes)}::text::jsonb
                 WHERE id = ${key.id}`.execute(db);
      revalidateSockets('principals');
      await Bun.sleep(20);
      await __sweepIdle();
    };
    await setScopes([{ collection: '*', actions: ['read'] }]);
    expect(s.isOpen()).toBe(true);
    s.send(SCOPED, 'still-reads');
    expect(s.delivered.join('')).toContain('still-reads');

    await setScopes([{ collection: UNSCOPED, actions: ['read'] }]);
    await expectEnded(s);
  });

  it('ends the stream of a key that loses its row-rule exemption, scopes unchanged', async () => {
    // Only `rls_bypass` changes, so a recheck that compared scopes alone kept
    // streaming the rows a row rule now hides from this key.
    const res = await app.request('/api/admin/rls', {
      method: 'POST',
      headers: { cookie: god, 'content-type': 'application/json' },
      body: JSON.stringify({
        collection: SCOPED,
        role: 'api_key',
        filter_field: 'title',
        filter_op: 'eq',
        filter_value_source: 'static:visible',
      }),
    });
    expect(res.status).toBeLessThan(300);
    try {
      const key = await createKey({ rls_bypass: true });
      const s = await openStream(key);
      s.send(SCOPED, 'hidden-before');
      expect(s.delivered.join('\n')).toContain('hidden-before');

      await sql`UPDATE zv_api_keys SET rls_bypass = false WHERE id = ${key.id}`.execute(db);
      revalidateSockets('principals');
      await Bun.sleep(20);
      await __sweepIdle();
      await expectEnded(s);
    } finally {
      await sql`DELETE FROM zvd_rls_policies WHERE collection = ${SCOPED}`.execute(db);
    }
  });

  it('401 for nobody, an unknown key and another tenant key', async () => {
    const raw = generateApiKey();
    await sql`
      INSERT INTO zv_api_keys (name, key_hash, key_prefix, scopes, is_active, tenant_id, created_by)
      VALUES (${`ssekey-${STAMP}-foreign`}, ${await hashApiKey(raw)}, ${raw.slice(0, 12)},
              ${JSON.stringify([{ collection: SCOPED, actions: ['read'] }])}::jsonb, true,
              ${FOREIGN_TENANT}::uuid, ${await createKeyCreator(db)})
    `.execute(db);
    const q = `collection=${SCOPED}`;
    expect((await stream(q, {})).status).toBe(401);
    expect((await stream(q, { 'X-API-Key': generateApiKey() })).status).toBe(401);
    expect((await stream(q, { 'X-API-Key': raw })).status).toBe(401);
  });
});

d('GET /api/api-keys/self', () => {
  let app: Hono;
  let db: Database;
  let god: string;
  let key: { id: string; key: string; key_prefix: string };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    const res = await app.request('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: god },
      body: JSON.stringify({
        name: `ssekey-self-${STAMP}`,
        scopes: [{ collection: 'posts', actions: ['read'] }],
      }),
    });
    expect(res.status).toBe(200);
    key = (await res.json()) as typeof key;
  });

  afterAll(async () => {
    if (db) await db.deleteFrom('zv_api_keys').where('id', '=', key.id).execute();
  });

  const self = (headers: Record<string, string>) => app.request('/api/api-keys/self', { headers });

  it('answers the presenting key, never its hash', async () => {
    const doors: Array<Record<string, string>> = [
      { 'X-API-Key': key.key },
      { Authorization: `Bearer ${key.key}` },
    ];
    for (const headers of doors) {
      const res = await self(headers);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        id: key.id,
        name: `ssekey-self-${STAMP}`,
        key_prefix: key.key_prefix,
        scopes: [{ collection: 'posts', actions: ['read'] }],
        tenant_id: '00000000-0000-0000-0000-000000000001',
        expires_at: null,
        rls_bypass: false,
      });
      expect(body).not.toHaveProperty('key_hash');
    }
  });

  it('403 for a session, 401 for nobody and for a revoked key', async () => {
    expect((await self({ cookie: god })).status).toBe(403);
    expect((await self({})).status).toBe(401);
    await db
      .updateTable('zv_api_keys')
      .set({ is_active: false })
      .where('id', '=', key.id)
      .execute();
    expect((await self({ 'X-API-Key': key.key })).status).toBe(401);
  });
});
