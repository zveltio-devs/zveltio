/**
 * m2m junction tables are tenant rows, isolated by Postgres like collections.
 *
 * `zvd_jnc_{source}_{target}` was created with no `tenant_id` and no policy,
 * while both tables it links are under FORCE RLS. Inside a tenant transaction
 * (`zveltio_rls`, which holds DML on every table in `public`) one tenant read
 * every other tenant's links and could delete them. Now the junction carries
 * `tenant_id` + the `tenant_isolation` policy from `applyTenantRLS`, and
 * migration 042 gives existing junctions the tenant of the source row.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile, splitSqlStatements } from '../../db/migrations/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { reconcileTenantRLS, withTenantIsolation } from '../../lib/tenancy/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROOT = '00000000-0000-0000-0000-000000000001';
const OTHER = crypto.randomUUID();
const SLUG = `jrls-${OTHER.slice(0, 8)}`;
const STAMP = Date.now().toString(36);
const TGT = `jrt_${STAMP}`;
const SRC = `jrs_${STAMP}`;
const J = `zvd_jnc_${SRC}_${TGT}`;
// The shape an older engine created, pointing the other way so it has its own name.
const LEGACY = `zvd_jnc_${TGT}_${SRC}`;
const MIGRATION = new URL('../../db/migrations/sql/042_junction_tenant_rls.sql', import.meta.url);

const count = async (trx: Database, table: string) =>
  (await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.id(table)}`.execute(trx)).rows[0]!
    .n;

async function privileges(db: Database, table: string, role: string): Promise<string[]> {
  const r = await sql<{ p: string }>`
    SELECT privilege_type AS p FROM information_schema.role_table_grants
     WHERE grantee = ${role} AND table_schema = 'public' AND table_name = ${table}
     ORDER BY 1
  `.execute(db);
  return r.rows.map((x) => x.p);
}

async function runUp(trx: Database): Promise<void> {
  const { up } = parseMigrationFile(await Bun.file(MIGRATION).text());
  for (const stmt of splitSqlStatements(up)) await sql.raw(stmt).execute(trx);
}

d('m2m junction tables under tenant RLS', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  const ids: Record<string, string> = {};

  const createRoute = async (name: string, fields: unknown[]) => {
    const res = await app.request('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name, display_name: name, fields }),
    });
    expect([200, 201, 202]).toContain(res.status);
    for (let i = 0; i < 150; i++) {
      const seen = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_policies
         WHERE schemaname = 'public' AND tablename = ${`zvd_${name}`} AND policyname = 'tenant_isolation'
      `.execute(db);
      if (seen.rows[0]!.n > 0) break;
      await Bun.sleep(100);
    }
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await sql`INSERT INTO zv_tenants (id, slug, name, status)
              VALUES (${OTHER}::uuid, ${SLUG}, ${SLUG}, 'active')`.execute(db);
    await createRoute(TGT, [{ name: 'name', type: 'text' }]);
    await createRoute(SRC, [
      { name: 'title', type: 'text' },
      { name: 'tags', type: 'm2m', options: { related_collection: TGT } },
    ]);
    for (const [k, table, tenant] of [
      ['sRoot', SRC, ROOT],
      ['sOther', SRC, OTHER],
      ['tRoot', TGT, ROOT],
      ['tOther', TGT, OTHER],
    ] as const) {
      const r = await sql<{ id: string }>`
        INSERT INTO ${sql.id(`zvd_${table}`)} (tenant_id) VALUES (${tenant}::uuid)
        RETURNING id::text AS id`.execute(db);
      ids[k] = r.rows[0]!.id;
    }
    // ROOT's link, written the way a request in ROOT writes it.
    await withTenantIsolation(ROOT, (trx) =>
      sql`INSERT INTO ${sql.id(J)} (${sql.id(`${SRC}_id`)}, ${sql.id(`${TGT}_id`)})
          VALUES (${ids.sRoot}::uuid, ${ids.tRoot}::uuid)`.execute(trx),
    );
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DROP TABLE IF EXISTS ${sql.id(LEGACY)} CASCADE`.execute(db).catch(() => {});
    for (const name of [SRC, TGT]) {
      await DDLManager.dropCollection(db, name, { force: true }).catch(() => {});
    }
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER}::uuid`.execute(db).catch(() => {});
  });

  it('another tenant does not see the links', async () => {
    expect(await withTenantIsolation(ROOT, (trx) => count(trx, J))).toBe(1);
    expect(await withTenantIsolation(OTHER, (trx) => count(trx, J))).toBe(0);
  });

  it('another tenant cannot delete them', async () => {
    await withTenantIsolation(OTHER, (trx) => sql`DELETE FROM ${sql.id(J)}`.execute(trx));
    expect(await count(db, J)).toBe(1);
  });

  it('a link written under a tenant lands in that tenant', async () => {
    const r = await withTenantIsolation(OTHER, (trx) =>
      sql<{ tenant_id: string }>`
        INSERT INTO ${sql.id(J)} (${sql.id(`${SRC}_id`)}, ${sql.id(`${TGT}_id`)})
        VALUES (${ids.sOther}::uuid, ${ids.tOther}::uuid) RETURNING tenant_id::text AS tenant_id
      `.execute(trx),
    );
    expect(r.rows).toEqual([{ tenant_id: OTHER }]);
  });

  it('a link cannot be aimed at another tenant', async () => {
    await expect(
      withTenantIsolation(OTHER, (trx) =>
        sql`INSERT INTO ${sql.id(J)} (${sql.id(`${SRC}_id`)}, ${sql.id(`${TGT}_id`)}, tenant_id)
            VALUES (${ids.sRoot}::uuid, ${ids.tRoot}::uuid, ${ROOT}::uuid)`.execute(trx),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('the narrow roles hold the collection grant on it, kept by the boot reconcile', async () => {
    await reconcileTenantRLS(db);
    expect(await privileges(db, J, 'zveltio_worker')).toEqual([
      'DELETE',
      'INSERT',
      'SELECT',
      'UPDATE',
    ]);
    expect(await privileges(db, J, 'zveltio_flow_reader')).toEqual(['SELECT']);
    // What the worker bridge does around a query: its role, the request's tenant.
    const seen = await db.transaction().execute(async (trx) => {
      await sql.raw('SET LOCAL ROLE zveltio_worker').execute(trx);
      await sql`SELECT set_config('zveltio.current_tenant', ${OTHER}, true)`.execute(trx);
      return (
        await sql<{
          s: string;
        }>`SELECT ${sql.id(`${SRC}_id`)}::text AS s FROM ${sql.id(J)}`.execute(trx)
      ).rows;
    });
    expect(seen).toEqual([{ s: ids.sOther! }]);
  }, 60_000);

  describe('migration 042 on a junction an older engine created', () => {
    beforeAll(async () => {
      await sql
        .raw(
          `CREATE TABLE "${LEGACY}" (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ` +
            `"${TGT}_id" UUID REFERENCES "zvd_${TGT}"(id) ON DELETE CASCADE, ` +
            `"${SRC}_id" UUID REFERENCES "zvd_${SRC}"(id) ON DELETE CASCADE, ` +
            'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
        )
        .execute(db);
      // Source decides; with no source, the target; with neither, the default tenant.
      await sql
        .raw(
          `INSERT INTO "${LEGACY}" ("${TGT}_id", "${SRC}_id") VALUES ` +
            `('${ids.tRoot}', '${ids.sOther}'), ('${ids.tOther}', '${ids.sRoot}'), ` +
            `(NULL, '${ids.sOther}'), (NULL, NULL)`,
        )
        .execute(db);
    });

    const backfilled = async (trx: Database) =>
      (
        await sql<{ k: string }>`
          SELECT coalesce(${sql.id(`${TGT}_id`)}::text, '-') || '>' || tenant_id::text AS k
            FROM ${sql.id(LEGACY)} ORDER BY 1`.execute(trx)
      ).rows.map((r) => r.k);
    const expected = () =>
      [`${ids.tRoot}>${ROOT}`, `${ids.tOther}>${OTHER}`, `->${OTHER}`, `->${ROOT}`].sort();

    it('as a plain owner role under FORCE RLS, backfills from the source row, twice', async () => {
      // Production runs migrations as a non-superuser owner, which FORCE RLS
      // binds: without every tenant published the source lookup sees only the
      // default tenant. The harness connects as a superuser, so the owner is
      // swapped for a plain role inside a transaction that is rolled back.
      const rollback = new Error('rollback');
      let got: string[] = [];
      await db
        .transaction()
        .execute(async (trx) => {
          for (const t of [`zvd_${SRC}`, `zvd_${TGT}`, LEGACY]) {
            await sql`ALTER TABLE ${sql.id(t)} OWNER TO zveltio_rls`.execute(trx);
          }
          await sql.raw('SET LOCAL ROLE zveltio_rls').execute(trx);
          await runUp(trx);
          await runUp(trx);
          got = await backfilled(trx);
          throw rollback;
        })
        .catch((err) => {
          if (err !== rollback) throw err;
        });
      expect(got.sort()).toEqual(expected());
    }, 60_000);

    it('then the boot reconcile isolates it', async () => {
      await db.transaction().execute(async (trx) => {
        await runUp(trx);
        await runUp(trx);
      });
      expect((await backfilled(db)).sort()).toEqual(expected());
      await reconcileTenantRLS(db);
      const r = await sql<{ force: boolean; pol: number; notnull: boolean }>`
        SELECT c.relforcerowsecurity AS force,
               (SELECT count(*)::int FROM pg_policies p
                 WHERE p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS pol,
               (SELECT a.attnotnull FROM pg_attribute a
                 WHERE a.attrelid = c.oid AND a.attname = 'tenant_id') AS notnull
          FROM pg_class c WHERE c.oid = to_regclass(${LEGACY})`.execute(db);
      expect(r.rows[0]).toEqual({ force: true, pol: 1, notnull: true });
      expect(await withTenantIsolation(OTHER, (trx) => count(trx, LEGACY))).toBe(2);
    }, 60_000);
  });
});
