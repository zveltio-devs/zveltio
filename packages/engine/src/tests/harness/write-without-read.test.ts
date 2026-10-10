/**
 * A principal that may write a collection but not read it.
 *
 * Migration 058 put collection permissions into the table (`zv_coll_*`), and
 * Postgres checks the SELECT policy on more than SELECT: `INSERT … RETURNING`,
 * `INSERT … ON CONFLICT`, and an `UPDATE`/`DELETE` whose WHERE reads a column
 * all need it. So a `create`-only grant was refused 42501 on every insert, and
 * an `update`- or `delete`-only grant answered 404 for every row — the engine's
 * own before-row lookup and the `WHERE id = …` were filtered to nothing.
 *
 * Owner decision: a caller who cannot read gets a response that names the row
 * and nothing more — `{ id }` for a create, `{ success, id }` for an update or
 * a delete. The engine's own statements (the before-row, the write and its
 * `RETURNING *`, the row it hands to revisions, webhooks, flows and listeners)
 * run inside a read window that never reaches the response. A caller who can
 * read keeps the full row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { dynamicInsert } from '../../db/dynamic.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  applyTenantRLS,
  collectionGrantsFor,
  getEnforcer,
  invalidateAllPermissionCaches,
  runWithDomain,
  withCollectionRead,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import {
  createGodSession,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const COLL = `wnr_${String(Date.now()).slice(-8)}`;
const TABLE = `zvd_${COLL}`;

d('writes by a principal that cannot read the collection', () => {
  let app: Hono;
  let db: Database;
  let god: string;
  const cookies: Record<string, string> = {};
  const keyIds: string[] = [];

  const req = (method: string, path: string, who: Record<string, string>, body?: unknown) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...who },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const seed = async (title: string) =>
    (
      await sql<{ id: string }>`INSERT INTO ${sql.table(TABLE)} (title, tenant_id)
        VALUES (${title}, ${TENANT}::uuid) RETURNING id`.execute(db)
    ).rows[0]!.id;
  const row = async (id: string) =>
    (
      await sql<{
        title: string;
      }>`SELECT title FROM ${sql.table(TABLE)} WHERE id = ${id}::uuid`.execute(db)
    ).rows[0];
  const revision = async (id: string, action: string) =>
    (
      await sql<{ data: Record<string, unknown> }>`SELECT data FROM zv_revisions
        WHERE collection = ${COLL} AND record_id = ${id} AND action = ${action}`.execute(db)
    ).rows[0];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    god = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLL,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await applyTenantRLS(db, TABLE);
    for (const [who, actions] of [
      ['creator', ['create']],
      ['updater', ['update']],
      ['deleter', ['delete']],
      ['reader', ['read', 'create', 'update']],
    ] as const) {
      cookies[who] = (
        await createMemberSession(app, db, {
          grants: [{ collection: COLL, actions: [...actions] }],
        })
      ).cookie;
    }
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    for (const id of keyIds) {
      await sql`DELETE FROM zv_api_key_access_log WHERE api_key_id = ${id}`
        .execute(db)
        .catch(() => {});
      await sql`DELETE FROM zv_api_keys WHERE id = ${id}`.execute(db).catch(() => {});
    }
    await sql`DELETE FROM zv_revisions WHERE collection = ${COLL}`.execute(db).catch(() => {});
    await dropTestCollection(db, COLL).catch(() => {});
  });

  it('create-only: 201 with only the id, the row and its revision are written', async () => {
    const res = await req(
      'POST',
      `/api/data/${COLL}`,
      { cookie: cookies.creator! },
      { title: 'c1' },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['id']);
    expect((await row(String(body.id)))?.title).toBe('c1');
    // The revision carries the stored row — defaults included — not just the input.
    const rev = await revision(String(body.id), 'create');
    expect(rev?.data.title).toBe('c1');
    expect(rev?.data.created_at).toBeTruthy();
  });

  it('create-only: bulk create answers ids only', async () => {
    const res = await req(
      'POST',
      `/api/data/${COLL}/bulk`,
      { cookie: cookies.creator! },
      { records: [{ title: 'b1' }, { title: 'b2' }] },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { created: number; records: Record<string, unknown>[] };
    expect(body.created).toBe(2);
    for (const r of body.records) {
      expect(Object.keys(r)).toEqual(['id']);
      expect((await row(String(r.id)))?.title).toMatch(/^b[12]$/);
    }
  });

  it('update-only: PATCH and bulk PATCH land, and answer without the row', async () => {
    const id = await seed('u0');
    const res = await req(
      'PATCH',
      `/api/data/${COLL}/${id}`,
      { cookie: cookies.updater! },
      { title: 'u1' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, id });
    expect((await row(id))?.title).toBe('u1');
    expect((await revision(id, 'update'))?.data.title).toBe('u1');

    const bulk = await req(
      'PATCH',
      `/api/data/${COLL}/bulk`,
      { cookie: cookies.updater! },
      { records: [{ id, title: 'u2' }] },
    );
    expect(bulk.status).toBe(200);
    const b = (await bulk.json()) as { updated: number; records: Record<string, unknown>[] };
    expect(b.updated).toBe(1);
    expect(b.records).toEqual([{ id }]);
    expect((await row(id))?.title).toBe('u2');

    // A row that does not exist is still not found.
    const missing = await req(
      'PATCH',
      `/api/data/${COLL}/${crypto.randomUUID()}`,
      { cookie: cookies.updater! },
      { title: 'x' },
    );
    expect(missing.status).toBe(404);
  });

  it('delete-only: DELETE and bulk DELETE remove the row', async () => {
    const id = await seed('d0');
    const res = await req('DELETE', `/api/data/${COLL}/${id}`, { cookie: cookies.deleter! });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, id });
    expect(await row(id)).toBeUndefined();

    const id2 = await seed('d1');
    const bulk = await req(
      'DELETE',
      `/api/data/${COLL}/bulk`,
      { cookie: cookies.deleter! },
      { ids: [id2] },
    );
    expect(bulk.status).toBe(200);
    expect(((await bulk.json()) as { deleted: number }).deleted).toBe(1);
    expect(await row(id2)).toBeUndefined();
  });

  it('an API key scoped [create] creates, and gets only the id', async () => {
    const made = await req(
      'POST',
      '/api/api-keys',
      { cookie: god },
      {
        name: `wnr key ${Date.now()}`,
        scopes: [{ collection: COLL, actions: ['create'] }],
      },
    );
    expect(made.status).toBe(200);
    const { id: keyId, key } = (await made.json()) as { id: string; key: string };
    keyIds.push(keyId);
    const res = await req('POST', `/api/data/${COLL}`, { 'X-API-Key': key }, { title: 'k1' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['id']);
    expect((await row(String(body.id)))?.title).toBe('k1');
  });

  it('sync push: create-, update- and delete-only operations land', async () => {
    const created = crypto.randomUUID();
    const push = (who: string, operations: unknown[]) =>
      req('POST', '/api/sync/push', { cookie: cookies[who]! }, { operations });

    let res = await push('creator', [
      { collection: COLL, recordId: created, operation: 'create', payload: { title: 's1' } },
    ]);
    expect(((await res.json()) as { results: unknown[] }).results).toEqual([
      expect.objectContaining({ recordId: created, status: 'ok' }),
    ]);
    expect((await row(created))?.title).toBe('s1');

    // The same id again is a conflict, as it is for a caller who can read.
    res = await push('creator', [
      { collection: COLL, recordId: created, operation: 'create', payload: { title: 's1b' } },
    ]);
    expect(((await res.json()) as { results: unknown[] }).results).toEqual([
      expect.objectContaining({ recordId: created, status: 'conflict' }),
    ]);

    res = await push('updater', [
      { collection: COLL, recordId: created, operation: 'update', payload: { title: 's2' } },
    ]);
    expect(((await res.json()) as { results: unknown[] }).results).toEqual([
      expect.objectContaining({ recordId: created, status: 'ok' }),
    ]);
    expect((await row(created))?.title).toBe('s2');

    res = await push('deleter', [
      { collection: COLL, recordId: created, operation: 'delete', payload: {} },
    ]);
    expect(((await res.json()) as { results: unknown[] }).results).toEqual([
      expect.objectContaining({ recordId: created, status: 'ok' }),
    ]);
    expect(await row(created)).toBeUndefined();
  });

  it('the public role: an anonymous create-only actor writes inside the read window', async () => {
    const e = await getEnforcer();
    await e.addPolicy('public', TENANT, COLL, 'create');
    await invalidateAllPermissionCaches();
    try {
      const g = await runWithDomain(TENANT, () => collectionGrantsFor('public'));
      const identity = {
        userId: '',
        email: '',
        role: 'public',
        roles: ['public'],
        bypass: false,
        collectionGrants: g.grants,
        collectionAll: g.all,
        anonymous: true,
      };
      const written = await withTenantIsolation(
        TENANT,
        (trx) => withCollectionRead(trx, COLL, () => dynamicInsert(trx, TABLE, { title: 'p1' })),
        { identity },
      );
      expect(written.title).toBe('p1');
      expect((await row(String(written.id)))?.title).toBe('p1');

      // The engine's read window is the call and no longer: overlapping windows
      // see the row, and once both settle the actor reads nothing again.
      const seen = (trx: Database) =>
        sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(TABLE)}`
          .execute(trx)
          .then((r) => r.rows[0]!.n);
      const after = await withTenantIsolation(
        TENANT,
        async (trx) => {
          const before = await seen(trx);
          const inside = await Promise.all([
            withCollectionRead(trx, COLL, () => seen(trx)),
            withCollectionRead(trx, COLL, () => seen(trx)),
          ]);
          return { before, inside, after: await seen(trx) };
        },
        { identity },
      );
      expect(after.before).toBe(0);
      expect(after.inside.every((n) => n > 0)).toBe(true);
      expect(after.after).toBe(0);
    } finally {
      await e.removePolicy('public', TENANT, COLL, 'create');
      await invalidateAllPermissionCaches();
    }
  });

  // `RETURNING` checks the new row against the SELECT policies, and the tenant
  // policy reads with a different set than it writes with: `zveltio_tenant_write_ok`
  // is the current unit, the read set is the reach. A member whose assignments
  // have all lapsed reaches NO unit, yet the membership door lets them into the
  // default tenant. The create-without-read path used to insert without
  // RETURNING and answer 201 — a write the same caller holding `read` too was
  // refused. Now both go through RETURNING and get the same answer.
  it('a lapsed member is refused a create alike, whether or not they can read', async () => {
    const lapsed = async (actions: string[]) => {
      const m = await createMemberSession(app, db, {
        grants: [{ collection: COLL, actions }],
      });
      await sql`INSERT INTO zv_tenant_users (tenant_id, user_id, role, valid_from, valid_to)
        VALUES (${TENANT}::uuid, ${m.userId}, 'member', now() - interval '2 days', now() - interval '1 day')
        ON CONFLICT (tenant_id, user_id) DO UPDATE
          SET valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to`.execute(db);
      return m.cookie;
    };
    for (const actions of [['create'], ['read', 'create']]) {
      const title = `lapsed-${actions.length}`;
      const res = await req(
        'POST',
        `/api/data/${COLL}`,
        { cookie: await lapsed(actions) },
        { title },
      );
      expect({ actions, status: res.status }).toEqual({ actions, status: 403 });
      const n = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(TABLE)}
        WHERE title = ${title}`.execute(db);
      expect(n.rows[0]!.n).toBe(0);
    }
  });

  it('a caller who can read keeps the full row', async () => {
    const res = await req(
      'POST',
      `/api/data/${COLL}`,
      { cookie: cookies.reader! },
      { title: 'r1' },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.title).toBe('r1');
    const patched = await req(
      'PATCH',
      `/api/data/${COLL}/${String(body.id)}`,
      { cookie: cookies.reader! },
      { title: 'r2' },
    );
    expect(((await patched.json()) as Record<string, unknown>).title).toBe('r2');
  });
});
