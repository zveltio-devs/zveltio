/**
 * An API key on the WebSocket — server-side realtime clients.
 *
 * `/api/ws` accepted only a session cookie, so a Node/Bun service holding an
 * API key could read a collection over REST and never subscribe to it. The
 * upgrade now authenticates through `authenticate` (the REST data routes'
 * helper), and the subscribe check goes through `checkAccess`, which is where
 * a key's scopes are enforced. Without that second half a key would be judged
 * by Casbin alone against the synthetic `apikey:<uuid>` subject.
 *
 * The upgrade is driven through the real route with a stand-in `server` that
 * records what `server.upgrade` was handed — the socket data the handlers read.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { __sweepIdle, revalidateSockets } from '../../lib/tenancy/index.js';
import { broadcastEvent, websocketHandler, _wsPermCacheForTests } from '../../routes/ws.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SCOPED = `wskey_ok_${Date.now()}`;
const UNSCOPED = `wskey_no_${Date.now()}`;

/** Calls `/api/ws` and returns the status plus the data the socket would open with. */
async function upgrade(app: Hono, headers: Record<string, string>) {
  let data: Record<string, unknown> | undefined;
  const server = {
    upgrade: (_req: Request, opts: { data: Record<string, unknown> }) => {
      data = opts.data;
      return true;
    },
  };
  const res = await app.request('/api/ws', { headers }, { server });
  return { status: res.status, data };
}

d('WebSocket accepts an API key and enforces its scopes', () => {
  let app: Hono;
  let db: Database;
  let rawKey: string;
  let keyId: string;
  let cookie: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    for (const name of [SCOPED, UNSCOPED]) {
      await DDLManager.createCollection(db, {
        name,
        fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
      } as never);
    }
    const keyRes = await app.request('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `Harness ws key ${Date.now()}`,
        scopes: [{ collection: SCOPED, actions: ['read'] }],
      }),
    });
    expect(keyRes.status).toBe(200);
    ({ id: keyId, key: rawKey } = (await keyRes.json()) as { id: string; key: string });
  });

  afterAll(async () => {
    if (!db) return;
    _wsPermCacheForTests().connections.delete('ws_key_probe');
    _wsPermCacheForTests().connections.delete('ws_key_bypass');
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${SCOPED}`.execute(db);
    await sql`DELETE FROM zv_api_keys WHERE name LIKE ${'Harness ws bypass key %'}`.execute(db);
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
    for (const name of [SCOPED, UNSCOPED]) {
      await sql
        .raw(`DROP TABLE IF EXISTS "zvd_${name}" CASCADE`)
        .execute(db)
        .catch(() => {});
      await db
        .deleteFrom('zvd_collections')
        .where('name', '=', name)
        .execute()
        .catch(() => {});
    }
  });

  it('refuses an upgrade with neither a session nor a key', async () => {
    const { status, data } = await upgrade(app, {});
    expect(status).toBe(401);
    expect(data).toBeUndefined();
  });

  it('refuses an upgrade with a key that does not exist', async () => {
    const { status } = await upgrade(app, { 'X-API-Key': 'zvk_not_a_real_key' });
    expect(status).toBe(401);
  });

  it('opens with a valid key, as the key, carrying its scopes', async () => {
    const { data } = await upgrade(app, { 'X-API-Key': rawKey });
    expect(data?.authType).toBe('api_key');
    expect(String(data?.userId)).toBe(`apikey:${keyId}`);
  });

  it('subscribes to the scoped collection and is denied the other', async () => {
    const { data } = await upgrade(app, { Authorization: `Bearer ${rawKey}` });
    const sent: string[] = [];
    const ws = {
      data: { ...data, id: 'ws_key_probe' },
      send: (p: string) => sent.push(p),
      close: () => {},
    };
    websocketHandler.open(ws as never);
    await websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', collections: [SCOPED, UNSCOPED] }),
    );
    const reply = sent
      .map((m) => JSON.parse(m) as { type: string; collections?: string[]; denied?: string[] })
      .find((m) => m.type === 'subscribed');
    expect(reply?.collections).toEqual([SCOPED]);
    expect(reply?.denied).toEqual([UNSCOPED]);
  });

  it('a key that loses its row-rule exemption stops hearing the rows a rule hides', async () => {
    // Only `rls_bypass` changes, so a recheck that compared scopes alone kept
    // the exempt gate on the open socket.
    const rule = await app.request('/api/admin/rls', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        collection: SCOPED,
        role: 'api_key',
        filter_field: 'title',
        filter_op: 'eq',
        filter_value_source: 'static:visible',
      }),
    });
    expect(rule.status).toBeLessThan(300);
    const keyRes = await app.request('/api/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `Harness ws bypass key ${Date.now()}`,
        scopes: [{ collection: SCOPED, actions: ['read'] }],
        rls_bypass: true,
      }),
    });
    expect(keyRes.status).toBe(200);
    const key = (await keyRes.json()) as { id: string; key: string };

    const { data } = await upgrade(app, { 'X-API-Key': key.key });
    const sent: string[] = [];
    const ws = {
      data: { ...data, id: 'ws_key_bypass' },
      send: (p: string) => sent.push(p),
      close: () => {},
    };
    websocketHandler.open(ws as never);
    await websocketHandler.message(
      ws as never,
      JSON.stringify({ type: 'subscribe', collections: [SCOPED] }),
    );
    const tenant = (data?.tenantId as string | null | undefined) ?? null;
    const heard = async (title: string) => {
      broadcastEvent(SCOPED, 'insert', { id: title, title }, tenant);
      await Bun.sleep(50);
      return sent.some((m) => m.includes(title));
    };
    expect(await heard('hidden-before')).toBe(true);

    await sql`UPDATE zv_api_keys SET rls_bypass = false WHERE id = ${key.id}`.execute(db);
    revalidateSockets('principals');
    await Bun.sleep(50);
    await __sweepIdle();

    expect(await heard('hidden-after')).toBe(false);
    expect(await heard('visible')).toBe(true);
    websocketHandler.close(ws as never);
  });
});
