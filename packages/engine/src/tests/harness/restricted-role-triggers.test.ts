/**
 * The triggers the engine attaches to a collection table keep working whichever
 * restricted role writes the row.
 *
 * A trigger function runs as the role that wrote the row unless it is SECURITY
 * DEFINER. Collection writes now arrive as `zveltio_ext` (inline extension in a
 * tenant transaction), `zveltio_worker` (the worker SQL bridge) and
 * `zveltio_rls` (REST), and each holds only the collection — so a trigger that
 * writes anywhere else fails that writer's ordinary INSERT/UPDATE/DELETE with
 * `permission denied`. Measured: the ghost-DDL changelog trigger did exactly
 * that for `zveltio_ext` and `zveltio_worker`, so every extension write to a
 * collection failed for as long as a ghost migration (a large add/alter, a
 * schema-branch merge) was copying it.
 *
 * Driven through the real paths: `ctx.db` from `createRestrictedDb` inside a
 * tenant transaction and on the pool, a real worker extension through the IPC
 * bridge, and REST with a god session.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, GhostDDL } from '../../lib/data/index.js';
import {
  _resetExtensionDbRoleForTests,
  grantExtensionDbRole,
} from '../../lib/extensions/ext-db-role.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { buildExtensionInternals } from '../../lib/extensions/internals.js';
import { applyTenantRLS, getCurrentTenantTrx } from '../../lib/tenancy/index.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const COLLECTION = `trgprobe_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const INLINE = 'trginline';
const WORKER = 'trgworker';

const ENTRY = `
export default {
  name: '${WORKER}',
  async register(app, ctx) {
    const run = async (c, q, ...p) => {
      try { return c.json({ ok: true, rows: await ctx.db.query(q, ...p) }); }
      catch (e) { return c.json({ ok: false, error: e.message }, 500); }
    };
    app.post('/rows', async (c) => run(c,
      'INSERT INTO ${TABLE} (title) VALUES ($1) RETURNING id', (await c.req.json()).title));
    app.patch('/rows/:id', async (c) => run(c,
      'UPDATE ${TABLE} SET title = $1 WHERE id = $2', (await c.req.json()).title, c.req.param('id')));
    app.delete('/rows/:id', async (c) => run(c,
      'DELETE FROM ${TABLE} WHERE id = $1', c.req.param('id')));
  },
};
`;

interface Writer {
  insert(title: string): Promise<string>;
  update(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
}

d('collection triggers under every restricted writer role', () => {
  let app: Hono;
  let db: Database;
  let base = '';
  const workerApp = new Hono();
  const writers: Record<string, Writer> = {};

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    const cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    // What the create_collection job does after the DDL: policy + narrow-role grants.
    await applyTenantRLS(db, TABLE);

    _resetExtensionDbRoleForTests();
    await grantExtensionDbRole(db, INLINE, new Set());
    const inTenant = <T>(fn: () => Promise<T>): Promise<T> =>
      buildExtensionInternals().withTenantIsolation(TENANT, fn);
    const kysely = (h: Database): Writer => ({
      insert: async (title) => {
        const r = await h
          .insertInto(TABLE as never)
          .values({ title } as never)
          .returning('id' as never)
          .executeTakeFirstOrThrow();
        return (r as { id: string }).id;
      },
      update: async (id, title) => {
        await h
          .updateTable(TABLE as never)
          .set({ title } as never)
          .where('id' as never, '=', id as never)
          .execute();
      },
      remove: async (id) => {
        await h
          .deleteFrom(TABLE as never)
          .where('id' as never, '=', id as never)
          .execute();
      },
    });
    const tenantExt = kysely(createRestrictedDb(() => getCurrentTenantTrx() ?? db, INLINE));
    writers['ctx.db in a tenant transaction'] = {
      insert: (t) => inTenant(() => tenantExt.insert(t)),
      update: (i, t) => inTenant(() => tenantExt.update(i, t)),
      remove: (i) => inTenant(() => tenantExt.remove(i)),
    };
    writers['ctx.db on the pool'] = kysely(createRestrictedDb(db, INLINE));

    base = mkdtempSync(join(tmpdir(), 'trg-wkr-'));
    const dir = join(base, WORKER);
    mkdirSync(join(dir, 'engine'), { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name: WORKER,
        version: '1.0.0',
        engine: { entry: 'engine/index.js', bundled: true, isolation: 'worker' },
      }),
    );
    writeFileSync(join(dir, 'engine', 'index.js'), ENTRY);
    _resetWorkerHostForTests();
    getWorkerHost(workerApp);
    const ctx = extensionLoader.ctx ?? ({ db, fieldTypeRegistry: { register() {} } } as never);
    await extensionLoader.loadExtension(WORKER, workerApp, ctx, base);
    expect(extensionLoader.getLastLoadError(WORKER)).toBeUndefined();
    const viaWorker = async (method: string, path: string, body?: unknown) => {
      const res = await workerApp.request(`/ext/${WORKER}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const out = (await res.json()) as { ok: boolean; rows?: { id: string }[]; error?: string };
      if (!out.ok) throw new Error(out.error);
      return out.rows ?? [];
    };
    writers['worker bridge'] = {
      insert: async (title) => (await viaWorker('POST', '/rows', { title }))[0]!.id,
      update: async (id, title) => void (await viaWorker('PATCH', `/rows/${id}`, { title })),
      remove: async (id) => void (await viaWorker('DELETE', `/rows/${id}`)),
    };

    const viaRest = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`/api/data/${COLLECTION}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status} ${text}`);
      return text ? (JSON.parse(text) as { data?: { id: string }; id?: string }) : {};
    };
    writers.REST = {
      insert: async (title) => {
        const r = await viaRest('POST', '', { title });
        return (r.data?.id ?? r.id)!;
      },
      update: async (id, title) => void (await viaRest('PATCH', `/${id}`, { title })),
      remove: async (id) => void (await viaRest('DELETE', `/${id}`)),
    };
  }, 120_000);

  afterAll(async () => {
    await getWorkerHost(workerApp).stopAll();
    _resetWorkerHostForTests();
    if (base) rmSync(base, { recursive: true, force: true });
    for (const t of [`_zv_ghost_${TABLE}`, `_zv_changelog_${TABLE}`, TABLE]) {
      await sql`DROP TABLE IF EXISTS ${sql.table(t)} CASCADE`.execute(db);
    }
    await sql`DROP FUNCTION IF EXISTS ${sql.id(`_zv_trg_ghost_${TABLE}_fn`)}()`.execute(db);
    await sql`DELETE FROM zv_sync_tombstones WHERE collection = ${TABLE}`.execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', COLLECTION).execute();
  });

  const row = async (id: string) =>
    (
      await sql<{ fts: boolean; updated_at: Date }>`
        SELECT search_vector IS NOT NULL AS fts, updated_at FROM ${sql.table(TABLE)} WHERE id = ${id}
      `.execute(db)
    ).rows[0];

  for (const name of [
    'ctx.db in a tenant transaction',
    'ctx.db on the pool',
    'worker bridge',
    'REST',
  ]) {
    it(`${name}: search vector, updated_at and the sync tombstone`, async () => {
      const w = writers[name]!;
      const id = await w.insert('alpha beta');
      const before = await row(id);
      expect(before?.fts).toBe(true);
      await w.update(id, 'gamma');
      expect((await row(id))!.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime());
      await w.remove(id);
      const tomb = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM zv_sync_tombstones
         WHERE collection = ${TABLE} AND row_id = ${id} AND tenant_id = ${TENANT}
      `.execute(db);
      expect(tomb.rows[0]!.n).toBe(1);
    }, 60_000);
  }

  it('pins every SECURITY DEFINER function to a search_path ending in pg_temp', async () => {
    // A path that does not name pg_temp searches it FIRST for relations, so a
    // definer function's unqualified table could resolve to a caller's
    // temporary object and run as the owner (migration 047).
    const r = await sql<{ fn: string; path: string }>`
      SELECT p.proname AS fn,
             coalesce((SELECT substr(c, 13) FROM unnest(p.proconfig) c
                        WHERE c LIKE 'search_path=%'), '') AS path
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.prosecdef AND n.nspname = 'public'
    `.execute(db);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.filter((x) => !/(^|,\s*)pg_temp$/.test(x.path))).toEqual([]);
  }, 30_000);

  describe('while a ghost migration copies the table', () => {
    beforeAll(async () => {
      await GhostDDL.createGhost(db, TABLE, [
        { kind: 'add_column', field: { name: 'extra', type: 'text', required: false } },
      ] as never);
    }, 60_000);

    for (const name of [
      'ctx.db in a tenant transaction',
      'ctx.db on the pool',
      'worker bridge',
      'REST',
    ]) {
      it(`${name}: every write reaches the changelog`, async () => {
        const w = writers[name]!;
        const id = await w.insert('during copy');
        await w.update(id, 'still copying');
        await w.remove(id);
        const ops = await sql<{ operation: string }>`
          SELECT operation FROM ${sql.table(`_zv_changelog_${TABLE}`)} WHERE row_id = ${id} ORDER BY id
        `.execute(db);
        expect(ops.rows.map((r) => r.operation)).toEqual(['INSERT', 'UPDATE', 'DELETE']);
      }, 60_000);
    }

    it('grants no restricted role the changelog itself', async () => {
      const r = await sql<{ role: string; ok: boolean }>`
        SELECT role, has_table_privilege(role, ${`_zv_changelog_${TABLE}`}, 'INSERT') AS ok
          FROM unnest(${['zveltio_ext', 'zveltio_worker']}::text[]) role
      `.execute(db);
      expect(r.rows.filter((x) => x.ok)).toEqual([]);
    }, 30_000);
  });
});
