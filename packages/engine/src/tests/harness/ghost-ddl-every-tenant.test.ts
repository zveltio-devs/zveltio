/**
 * A ghost migration copies every tenant's rows, not the default tenant's.
 *
 * In production the engine is a non-superuser that OWNS the collection tables,
 * and FORCE RLS binds it like anyone else. With no tenant published, the pool
 * reads a policed table as the default tenant — so `batchCopy` built a ghost of
 * the default tenant's rows only, the swap committed it, and the sixty-second
 * DROP of the old copy made every other tenant's rows unrecoverable.
 *
 * The harness pool is a superuser and never sees this, so the migration here
 * runs on a second connection that logs in as a plain owner role.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { createDb, type Database } from '../../db/index.js';
import {
  cancelPendingCleanups,
  DDLManager,
  GhostDDL,
  sweepGhostOrphans,
} from '../../lib/data/index.js';
import { applyTenantRLS, DEFAULT_TENANT_ID } from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = Date.now();
const COLLECTION = `hgt_${SFX}`;
const TABLE = `zvd_${COLLECTION}`;
const OWNER = `hgt_owner_${SFX}`;
const OTHER_TENANT = crypto.randomUUID();

d('ghost DDL under FORCE RLS, run by a non-superuser owner', () => {
  let db: Database;
  let owner: Database;

  /** Rows per tenant, read as the superuser pool (sees through RLS). */
  const perTenant = async () => {
    const r = await sql<{ tenant_id: string; n: number }>`
      SELECT tenant_id::text AS tenant_id, count(*)::int AS n
      FROM ${sql.id(TABLE)} GROUP BY 1 ORDER BY 1
    `.execute(db);
    return Object.fromEntries(r.rows.map((x) => [x.tenant_id, x.n]));
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await applyTenantRLS(db, TABLE);

    await sql`INSERT INTO zv_tenants (id, slug, name) VALUES (${OTHER_TENANT}, ${`hgt-${SFX}`}, 'hgt')`.execute(
      db,
    );
    await sql`
      INSERT INTO ${sql.id(TABLE)} (title, tenant_id)
      SELECT 'd' || g, ${DEFAULT_TENANT_ID}::uuid FROM generate_series(1, 30) g
      UNION ALL
      SELECT 'o' || g, ${OTHER_TENANT}::uuid FROM generate_series(1, 20) g
    `.execute(db);

    // The production shape: a plain role that owns the table and nothing more.
    await sql.raw(`CREATE ROLE ${OWNER} LOGIN PASSWORD 'hgt' NOSUPERUSER NOBYPASSRLS`).execute(db);
    await sql.raw(`GRANT CREATE ON SCHEMA public TO ${OWNER}`).execute(db);
    await sql.raw(`GRANT SELECT ON zvd_collections, zv_tenants TO ${OWNER}`).execute(db);
    await sql.raw(`GRANT REFERENCES ON "user" TO ${OWNER}`).execute(db);
    await sql.raw(`ALTER TABLE ${TABLE} OWNER TO ${OWNER}`).execute(db);

    const url = new URL(String(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL));
    url.username = OWNER;
    url.password = 'hgt';
    owner = createDb(url.toString());
  });

  afterAll(async () => {
    if (!db) return;
    cancelPendingCleanups();
    await owner?.destroy().catch(() => {});
    for (const t of [`_zv_ghost_${TABLE}`, `_zv_changelog_${TABLE}`, TABLE]) {
      await sql`DROP TABLE IF EXISTS ${sql.id(t)} CASCADE`.execute(db).catch(() => {});
    }
    await sweepGhostOrphans(db);
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
    await sql`DELETE FROM zv_tenants WHERE id = ${OTHER_TENANT}`.execute(db).catch(() => {});
    await sql
      .raw(`DROP OWNED BY ${OWNER}`)
      .execute(db)
      .catch(() => {});
    await sql
      .raw(`DROP ROLE IF EXISTS ${OWNER}`)
      .execute(db)
      .catch(() => {});
  });

  it('keeps every tenant’s rows through the swap', async () => {
    const before = await perTenant();
    expect(before).toEqual({ [DEFAULT_TENANT_ID]: 30, [OTHER_TENANT]: 20 });

    await GhostDDL.execute(owner, TABLE, [
      { kind: 'add_column', field: { name: 'note', type: 'text' } },
    ]);

    expect(await perTenant()).toEqual(before);
  });

  it('refuses the swap when the ghost is missing rows, leaving the original in place', async () => {
    // The previous swap's old copy and changelog, as its 60 s timer would.
    cancelPendingCleanups();
    await sweepGhostOrphans(db);
    const before = await perTenant();
    const migration = await GhostDDL.createGhost(owner, TABLE, [
      { kind: 'add_column', field: { name: 'extra', type: 'text' } },
    ]);
    await GhostDDL.batchCopy(owner, migration);
    // A copy that lost one row, whatever the cause.
    await sql`DELETE FROM ${sql.id(migration.ghostTable)} WHERE title = 'o1'`.execute(db);

    await expect(GhostDDL.atomicSwap(owner, migration)).rejects.toThrow(/row count/i);

    expect(await perTenant()).toEqual(before);
    const cols = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = ${TABLE} AND column_name = 'extra'
    `.execute(db);
    expect(cols.rows[0]?.n).toBe(0);
  });
});
