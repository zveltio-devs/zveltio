/**
 * Offline sync asks Casbin the same question every other door asks.
 *
 * Push and pull checked `checkPermission(user, 'data:<collection>', …)`.
 * Migration 001 stripped the `data:` prefix from every collection policy, the
 * Studio's permission matrix writes `(role, '*', <collection>, action)`, and the
 * matcher compares objects by plain equality — so no grant an operator can make
 * satisfied sync. A member who reads and writes a collection through
 * `/api/data` and realtime had every push refused and every pull come back
 * empty; only god and a `*`/`*` grant could sync at all.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hsyncname_${Date.now()}`;

d('sync uses the collection permission name (in-process)', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';
  let memberCookie = '';
  let outsiderCookie = '';
  let seededId = '';

  const push = (cookie: string, operations: unknown[]) =>
    app.request('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ operations }),
    });

  const pull = async (cookie: string) => {
    const res = await app.request('/api/sync/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ collections: [COLLECTION] }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { changes: Array<{ data?: { id?: string; title?: string } }> };
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);
    // The grant exactly as the Studio's permission matrix writes it.
    ({ cookie: memberCookie } = await createMemberSession(app, db, {
      grants: [{ collection: COLLECTION, actions: ['read', 'create', 'update', 'delete'] }],
    }));
    ({ cookie: outsiderCookie } = await createMemberSession(app, db));

    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    const created = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({ title: 'seeded' }),
    });
    expect(created.status).toBe(201);
    seededId = ((await created.json()) as { id: string }).id;
  });

  afterAll(async () => {
    if (db) await dropTestCollection(db, COLLECTION).catch(() => {});
  });

  it('the member reads the collection through /api/data (the grant works there)', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${seededId}`, {
      headers: { cookie: memberCookie },
    });
    expect(res.status).toBe(200);
  });

  it('pulls what /api/data lets the member read', async () => {
    const titles = (await pull(memberCookie)).changes.map((ch) => ch.data?.title);
    expect(titles).toContain('seeded');
  });

  it('pushes a create, an update and a delete the member may make through /api/data', async () => {
    const newId = crypto.randomUUID();
    const res = await push(memberCookie, [
      {
        collection: COLLECTION,
        recordId: newId,
        operation: 'create',
        payload: { title: 'offline' },
      },
      {
        collection: COLLECTION,
        recordId: seededId,
        operation: 'update',
        payload: { title: 'edited' },
      },
      { collection: COLLECTION, recordId: newId, operation: 'delete' },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ status: string; error?: string }> };
    expect(body.results.map((r) => r.error ?? r.status)).toEqual(['ok', 'ok', 'ok']);
  });

  it('still refuses a user with no grant on the collection', async () => {
    expect((await pull(outsiderCookie)).changes).toEqual([]);
    const res = await push(outsiderCookie, [
      { collection: COLLECTION, recordId: seededId, operation: 'update', payload: { title: 'x' } },
    ]);
    const body = (await res.json()) as { results: Array<{ status: string }> };
    expect(body.results[0]?.status).toBe('error');
  });
});
