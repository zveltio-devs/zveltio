/**
 * A ghost migration never swaps away rows the owner's RLS reach cannot see.
 *
 * The copy and the swap guard read the original with every `zv_tenants` row
 * published. A row whose `tenant_id` names no tenant — its firm deleted, data
 * imported or restored as a superuser — is invisible to both: the copy skipped
 * it, the guard's count agreed with the ghost's, the swap committed, and the
 * post-swap DROP of `_zv_old_<table>` destroyed it.
 *
 * The harness pool is a superuser and sees through RLS, so the migration runs on
 * a second connection logged in as a plain NOSUPERUSER NOBYPASSRLS owner.
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
const COLLECTION = `hgh_${SFX}`;
const TABLE = `zvd_${COLLECTION}`;
const OWNER = `hgh_owner_${SFX}`;
/** A tenant id with no `zv_tenants` row. */
const GONE_TENANT = crypto.randomUUID();

d('ghost DDL with rows outside every published tenant', () => {
  let db: Database;
  let owner: Database;

  const perTenant = async () => {
    const r = await sql<{ tenant_id: string; n: number }>`
      SELECT tenant_id::text AS tenant_id, count(*)::int AS n
      FROM ${sql.id(TABLE)} GROUP BY 1 ORDER BY 1
    `.execute(db);
    return Object.fromEntries(r.rows.map((x) => [x.tenant_id, x.n]));
  };

  const forced = async () => {
    const r = await sql<{ f: boolean }>`
      SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = ${TABLE}::regclass
    `.execute(db);
    return r.rows[0]?.f;
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await applyTenantRLS(db, TABLE);
    await sql`
      INSERT INTO ${sql.id(TABLE)} (title, tenant_id)
      SELECT 'd' || g, ${DEFAULT_TENANT_ID}::uuid FROM generate_series(1, 30) g
      UNION ALL
      SELECT 'x' || g, ${GONE_TENANT}::uuid FROM generate_series(1, 5) g
    `.execute(db);

    await sql.raw(`CREATE ROLE ${OWNER} LOGIN PASSWORD 'hgh' NOSUPERUSER NOBYPASSRLS`).execute(db);
    await sql.raw(`GRANT CREATE ON SCHEMA public TO ${OWNER}`).execute(db);
    await sql.raw(`GRANT SELECT ON zvd_collections, zv_tenants TO ${OWNER}`).execute(db);
    await sql.raw(`GRANT REFERENCES ON "user" TO ${OWNER}`).execute(db);
    await sql.raw(`ALTER TABLE ${TABLE} OWNER TO ${OWNER}`).execute(db);

    const url = new URL(String(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL));
    url.username = OWNER;
    url.password = 'hgh';
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
    await sql
      .raw(`DROP OWNED BY ${OWNER}`)
      .execute(db)
      .catch(() => {});
    await sql
      .raw(`DROP ROLE IF EXISTS ${OWNER}`)
      .execute(db)
      .catch(() => {});
  });

  it('refuses the swap instead of dropping the hidden rows', async () => {
    const before = await perTenant();
    expect(before).toEqual({ [DEFAULT_TENANT_ID]: 30, [GONE_TENANT]: 5 });

    const failure = await GhostDDL.execute(owner, TABLE, [
      { kind: 'add_column', field: { name: 'note', type: 'text' } },
    ]).then(
      () => null,
      (err: Error) => err,
    );

    // The live table still holds every row — before the fix the swapped-in copy
    // held the 30 visible ones and the 5 waited in `_zv_old_` for the DROP.
    expect(await perTenant()).toEqual(before);
    expect(failure?.message).toMatch(/row count/i);
    const old = await sql<{ t: string | null }>`
      SELECT to_regclass(${`_zv_old_${TABLE}`})::text AS t
    `.execute(db);
    expect(old.rows[0]?.t).toBeNull();
    expect(await forced()).toBe(true);
  });

  it('still swaps a table whose every row is visible, keeping FORCE RLS', async () => {
    await sql`DELETE FROM ${sql.id(TABLE)} WHERE tenant_id = ${GONE_TENANT}::uuid`.execute(db);
    const before = await perTenant();

    await GhostDDL.execute(owner, TABLE, [
      { kind: 'add_column', field: { name: 'note', type: 'text' } },
    ]);

    expect(await perTenant()).toEqual(before);
    expect(await forced()).toBe(true);
  });
});
