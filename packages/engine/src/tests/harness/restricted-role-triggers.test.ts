/**
 * The triggers the engine attaches to a collection table keep working whichever
 * restricted role writes the row.
 *
 * A trigger function runs as the role that wrote the row unless it is SECURITY
 * DEFINER. Collection writes now arrive as `zveltio_ext` (inline extension in a
 * tenant transaction) and `zveltio_rls` (REST) — no SQL crosses from a worker
 * any more (RFC extension-model-v3 decision 2), and each holds only the collection — so a trigger that
 * writes anywhere else fails that writer's ordinary INSERT/UPDATE/DELETE with
 * `permission denied`. Measured: an online-migration changelog trigger (since
 * removed, ADR 0041) did exactly that for `zveltio_ext` and `zveltio_worker`, so
 * every extension write to a collection failed while the migration ran.
 *
 * Driven through the real paths: `ctx.db` from `createRestrictedDb` inside a
 * tenant transaction and on the pool, and REST with a god session.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  _resetExtensionDbRoleForTests,
  grantExtensionDbRole,
  revokeExtensionDbRoles,
} from '../../lib/extensions/ext-db-role.js';
import { _setInlineForTests } from '../../lib/extensions/load-phases.js';
import { createRestrictedDb } from '../../lib/extensions/extension-context.js';
import { applyTenantRLS, getCurrentTenantTrx } from '../../lib/tenancy/index.js';
import { withTenantIsolation } from '../../lib/tenancy/index.js';
import {
  ALL_COLLECTIONS_ACTOR,
  asDefaultTenant,
  connectedAsSuperuser,
  createGodSession,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
/**
 * `ctx.db` on the pool writes a collection only on a superuser engine, as the
 * extension's BYPASSRLS twin. On the documented owner role it has no actor, so
 * collection permissions (R1) refuse it by design — nothing to measure there.
 */
const SUPER = harnessAvailable() && (await connectedAsSuperuser((await getTestApp()).db));
const poolUnwritable = (writer: string) => writer === 'ctx.db on the pool' && !SUPER;
const TENANT = '00000000-0000-0000-0000-000000000001';
const COLLECTION = `trgprobe_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const INLINE = 'trginline';

interface Writer {
  insert(title: string): Promise<string>;
  update(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
}

d('collection triggers under every restricted writer role', () => {
  let app: Hono;
  let db: Database;
  const writers: Record<string, Writer> = {};

  beforeAll(async () => {
    _setInlineForTests(true); // unsigned fixtures: the test override stands in for a signature
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
      withTenantIsolation(TENANT, fn, { identity: ALL_COLLECTIONS_ACTOR });
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
    _setInlineForTests(false);
    await sql`DROP TABLE IF EXISTS ${sql.table(TABLE)} CASCADE`.execute(db);
    await asDefaultTenant(db, sql`DELETE FROM zv_sync_tombstones WHERE collection = ${TABLE}`);
    await db.deleteFrom('zvd_collections').where('name', '=', COLLECTION).execute();
    // Roles are cluster-wide and outlive the test database.
    await revokeExtensionDbRoles(db, INLINE, true);
  });

  const row = async (id: string) =>
    (
      await asDefaultTenant(
        db,
        sql<{ fts: boolean; updated_at: Date }>`
        SELECT search_vector IS NOT NULL AS fts, updated_at FROM ${sql.table(TABLE)} WHERE id = ${id}
      `,
      )
    ).rows[0];

  for (const name of [
    'ctx.db in a tenant transaction',
    'ctx.db on the pool',
    'REST',
  ]) {
    it.skipIf(poolUnwritable(name))(
      `${name}: search vector, updated_at and the sync tombstone`,
      async () => {
        const w = writers[name]!;
        const id = await w.insert('alpha beta');
        const before = await row(id);
        expect(before?.fts).toBe(true);
        await w.update(id, 'gamma');
        expect((await row(id))!.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime());
        await w.remove(id);
        const tomb = await asDefaultTenant(
          db,
          sql<{ n: number }>`
        SELECT count(*)::int AS n FROM zv_sync_tombstones
         WHERE collection = ${TABLE} AND row_id = ${id} AND tenant_id = ${TENANT}
      `,
        );
        expect(tomb.rows[0]!.n).toBe(1);
      },
      60_000,
    );
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
    expect(r.rows.map((x) => x.fn)).toContain('zveltio_sync_tombstone');
    expect(r.rows.filter((x) => !/(^|,\s*)pg_temp$/.test(x.path))).toEqual([]);
  }, 30_000);
});
