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
import { websocketHandler, _wsPermCacheForTests } from '../../routes/ws.js';
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

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    const cookie = await createGodSession(app, db);
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
});
