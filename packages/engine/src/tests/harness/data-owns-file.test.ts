/**
 * ADR 0061 decision 2: a `file` field declared `ownsFile: true`.
 *
 * A file id enters the field only when its writer could delete that file; from
 * then on the row owns it, and the engine deletes the stored file — its
 * `zv_media_files` row in the write's transaction, its bytes after the commit —
 * when the row is deleted (single or bulk) or the field stops holding it. A
 * plain `file` field keeps today's behaviour. Through the engine's data routes,
 * as members, on migration 115's file RLS and the local storage driver.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getAuth } from '../../lib/auth.js';
import { CollectionSchema, DDLManager } from '../../lib/data/index.js';
import { problemOnError } from '../../lib/problem.js';
import { getStorage } from '../../lib/storage/index.js';
import { type FileActor, storeFile } from '../../lib/stored-files.js';
import { DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import { sessionPrefetch } from '../../middleware/session-prefetch.js';
import { tenantMiddleware } from '../../middleware/tenant.js';
import { dataRoutes } from '../../routes/data.js';
import {
  asEveryTenant,
  asTenant,
  createMemberSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const C = `ownsfile_${Date.now()}`;

d('a file field that owns its file (ADR 0061 decision 2)', () => {
  let engine: Hono;
  /** The data routes with a middleware that fails the request after its write, on `x-fail`. */
  let failing: Hono;
  let db: Database;
  let user: { cookie: string; userId: string };
  let colleague: { cookie: string; userId: string };
  const madeFiles: string[] = [];

  /** A file stored as `userId`'s private upload (or the tenant's, `shared`). */
  const make = async (userId: string, shared = false) => {
    const actor: FileActor = {
      tenantId: DEFAULT_TENANT_ID,
      principalId: userId,
      author: userId,
      apiKeyRow: null,
      seesAll: false,
    };
    const r = await asTenant(db, DEFAULT_TENANT_ID, async (trx) => {
      const s = await storeFile(trx, actor, { name: 'doc.txt', bytes: new Uint8Array(5).fill(7) });
      if ('file' in s && shared) {
        await trx
          .updateTable('zv_media_files')
          .set({ visibility: 'tenant' })
          .where('id', '=', s.file.id)
          .execute();
      }
      return s;
    });
    if (!('file' in r)) throw new Error(`fixture refused: ${r.body.error}`);
    madeFiles.push(r.file.id);
    return { id: r.file.id, path: r.file.storage_path };
  };
  const ref = (f: { id: string }) => ({ id: f.id, name: 'doc.txt' });
  const fileRow = (id: string) =>
    asEveryTenant(db, (trx) =>
      trx.selectFrom('zv_media_files').select('id').where('id', '=', id).executeTakeFirst(),
    );
  const bytes = async (path: string) => (await getStorage().get(path)) !== null;
  /** Whether file `f` is gone, row and bytes — the bytes go after the commit. */
  const gone = async (f: { id: string; path: string }) => {
    for (let i = 0; i < 40 && (await bytes(f.path)); i++) await Bun.sleep(25);
    return !(await fileRow(f.id)) && !(await bytes(f.path));
  };
  const kept = async (f: { id: string; path: string }) =>
    Boolean(await fileRow(f.id)) && (await bytes(f.path));

  const call = (method: string, path: string, cookie: string, body?: unknown, on = engine) =>
    on.request(`/api/data/${C}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const create = async (body: Record<string, unknown>, cookie = user.cookie) => {
    const res = await call('POST', '', cookie, { title: 't', ...body });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const rows = async () =>
    (
      await asEveryTenant(db, (trx) =>
        sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(`zvd_${C}`)}`.execute(trx),
      )
    ).rows[0]!.n;

  beforeAll(async () => {
    ({ app: engine, db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: C,
      fields: [
        { name: 'title', type: 'text' },
        { name: 'doc', type: 'file', ownsFile: true },
        { name: 'docs', type: 'file', ownsFile: true, options: { multiple: true } },
        { name: 'attachment', type: 'file' },
      ],
    } as never);
    const grants = [{ collection: C, actions: ['create', 'read', 'update', 'delete'] }];
    user = await createMemberSession(engine, db, { grants });
    colleague = await createMemberSession(engine, db, { grants });

    failing = new Hono();
    failing.onError(problemOnError);
    failing.use('/api/*', sessionPrefetch(getAuth(), db));
    failing.use('/api/*', tenantMiddleware);
    failing.use('/api/*', async (c, next) => {
      await next();
      if (c.req.header('x-fail')) throw new Error('the request failed after its write');
    });
    failing.route('/api/data', dataRoutes(db, getAuth()));
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await dropTestCollection(db, C);
    const paths = await asEveryTenant(db, (trx) =>
      madeFiles.length
        ? trx
            .selectFrom('zv_media_files')
            .select('storage_path')
            .where('id', 'in', madeFiles)
            .execute()
        : Promise.resolve([]),
    );
    for (const p of paths)
      await getStorage()
        .delete(p.storage_path)
        .catch(() => {});
    if (madeFiles.length) {
      await asEveryTenant(db, (trx) =>
        trx.deleteFrom('zv_media_files').where('id', 'in', madeFiles).execute(),
      );
    }
  });

  it('a schema file may declare ownsFile only on a file field', () => {
    const parse = (type: string) =>
      CollectionSchema.safeParse({ name: 'x', fields: [{ name: 'n', type, ownsFile: true }] });
    expect(parse('text').success).toBe(false);
    const file = parse('file');
    expect(file.success && file.data.fields[0]!.ownsFile).toBe(true);
  });

  it('refuses a file the writer could not delete, and writes nothing', async () => {
    const before = await rows();
    // Readable (the tenant's), not deletable: a colleague's upload.
    const shared = await make(colleague.userId, true);
    // Neither readable nor deletable: a colleague's private upload.
    const hidden = await make(colleague.userId);
    for (const f of [shared, hidden]) {
      const r = await create({ doc: ref(f) });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('file_not_claimable');
      // The same answer for both: it does not tell whether the file exists.
      expect(String(r.body.detail)).toBe(
        `doc: file ${f.id} is not one you may delete, so this record cannot own it`,
      );
    }
    // In a list, one foreign file refuses the write.
    const mine = await make(user.userId);
    expect((await create({ docs: [ref(mine), ref(shared)] })).status).toBe(403);
    // Nor through bulk create, nor by an update.
    const bulk = await call('POST', '/bulk', user.cookie, { records: [{ doc: ref(shared) }] });
    expect(bulk.status).toBe(422);
    const own = await create({});
    const patch = await call('PATCH', `/${own.body.id}`, user.cookie, { doc: ref(shared) });
    expect(patch.status).toBe(403);
    expect(await rows()).toBe(before + 1);
    expect(await kept(shared)).toBe(true);
  });

  it('a row deleted by another member takes its file with it', async () => {
    const f = await make(user.userId);
    const r = await create({ doc: ref(f) });
    expect(r.status).toBe(201);
    // The colleague may delete the row; the row's rules decided that, not the file's.
    const del = await call('DELETE', `/${r.body.id}`, colleague.cookie);
    expect(del.status).toBe(200);
    expect(await gone(f)).toBe(true);
  });

  it("a bulk delete takes every row's files", async () => {
    const [a, b, c] = [await make(user.userId), await make(user.userId), await make(user.userId)];
    const r1 = await create({ doc: ref(a) });
    const r2 = await create({ docs: [ref(b), ref(c)] });
    const del = await call('DELETE', '/bulk', user.cookie, { ids: [r1.body.id, r2.body.id] });
    expect(del.status).toBe(200);
    for (const f of [a, b, c]) expect(await gone(f)).toBe(true);
  });

  it('overwriting or clearing the field deletes the file it held', async () => {
    const [first, second, third] = [
      await make(user.userId),
      await make(user.userId),
      await make(user.userId),
    ];
    const r = await create({ doc: ref(first), docs: [ref(second), ref(third)] });
    expect(r.status).toBe(201);
    // Re-sending what the row holds asks nothing and releases nothing.
    expect((await call('PATCH', `/${r.body.id}`, user.cookie, { doc: ref(first) })).status).toBe(
      200,
    );
    expect(await kept(first)).toBe(true);
    const next = await make(user.userId);
    expect((await call('PATCH', `/${r.body.id}`, user.cookie, { doc: ref(next) })).status).toBe(
      200,
    );
    expect(await gone(first)).toBe(true);
    expect(await kept(next)).toBe(true);
    // A list loses one file: that one goes.
    const bulk = await call('PATCH', '/bulk', user.cookie, {
      records: [{ id: r.body.id, docs: [ref(third)] }],
    });
    expect(bulk.status).toBe(200);
    expect(await gone(second)).toBe(true);
    expect(await kept(third)).toBe(true);
    // Cleared.
    expect((await call('PATCH', `/${r.body.id}`, user.cookie, { doc: null })).status).toBe(200);
    expect(await gone(next)).toBe(true);
  });

  it('a sync-pushed delete takes the file, and a sync write may not set the field', async () => {
    const f = await make(user.userId);
    const r = await create({ doc: ref(f) });
    const push = (operations: unknown[]) =>
      engine.request('/api/sync/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: user.cookie },
        body: JSON.stringify({ operations }),
      });
    const other = await make(user.userId);
    const set = await push([
      {
        collection: C,
        recordId: crypto.randomUUID(),
        operation: 'create',
        payload: { title: 's', doc: ref(other) },
        clientTimestamp: Date.now(),
      },
    ]);
    const setResults = ((await set.json()) as { results: { status: string }[] }).results;
    expect(setResults[0]!.status).not.toBe('ok');
    const del = await push([
      { collection: C, recordId: r.body.id, operation: 'delete', clientTimestamp: Date.now() },
    ]);
    const delResults = ((await del.json()) as { results: { status: string }[] }).results;
    expect(delResults[0]!.status).toBe('ok');
    expect(await gone(f)).toBe(true);
  });

  it('a row delete that rolls back leaves the file', async () => {
    const f = await make(user.userId);
    const r = await create({ doc: ref(f) });
    const res = await failing.request(`/api/data/${C}/${r.body.id}`, {
      method: 'DELETE',
      headers: { cookie: user.cookie, 'x-fail': '1' },
    });
    expect(res.status).toBe(500);
    await Bun.sleep(200);
    expect(await kept(f)).toBe(true);
    const still = await call('GET', `/${r.body.id}`, user.cookie);
    expect(still.status).toBe(200);
  });

  it('a plain file field keeps today: any file, and it outlives the row', async () => {
    const shared = await make(colleague.userId, true);
    const r = await create({ attachment: ref(shared) });
    expect(r.status).toBe(201);
    expect((await call('DELETE', `/${r.body.id}`, user.cookie)).status).toBe(200);
    expect(await kept(shared)).toBe(true);
  });
});
