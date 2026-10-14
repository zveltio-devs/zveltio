/**
 * A collection table exists with tenant RLS on it, or does not exist at all
 * (owner decision 2026-10-14).
 *
 * Every create path applied `applyTenantRLS` after CREATE TABLE had committed,
 * and the create_collection job and an extension's `ctx.DDLManager` caught its
 * failure, warned and returned success: a `zvd_` table every tenant read. A
 * junction table had the same gap without the catch — the throw left the
 * committed table behind.
 *
 * The failure is planted for real: with `zveltio_tenant_write_ok(uuid)` renamed
 * away, the tenant_isolation policy cannot be created.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, runCreateCollection } from '../../lib/data/index.js';
import { announcingDDLManager } from '../../lib/extensions/register.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = Date.now();
const FIELDS = [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }];
const JOB = `rlsfc_job_${SFX}`;
const EXT = `rlsfc_ext_${SFX}`;
const SRC = `rlsfc_src_${SFX}`;
const DST = `rlsfc_dst_${SFX}`;
const JNC = `zvd_jnc_${SRC}_${DST}`;

const HIDDEN = 'zveltio_tenant_write_ok_rlsfc_hidden';

d('collection create is fail-closed on tenant RLS', () => {
  let db: Database;

  const exists = async (table: string) =>
    (
      await sql<{ t: string | null }>`SELECT to_regclass(${`public.${table}`})::text AS t`.execute(
        db,
      )
    ).rows[0]?.t != null;

  /** Run `fn` while the tenant_isolation policy cannot be created. */
  const withRlsBroken = async (fn: () => Promise<unknown>) => {
    await sql.raw(`ALTER FUNCTION zveltio_tenant_write_ok(uuid) RENAME TO ${HIDDEN}`).execute(db);
    try {
      return await fn().then(
        () => null,
        (e: Error) => e,
      );
    } finally {
      await sql.raw(`ALTER FUNCTION ${HIDDEN}(uuid) RENAME TO zveltio_tenant_write_ok`).execute(db);
    }
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw(`DROP TABLE IF EXISTS "${JNC}" CASCADE`).execute(db);
    for (const n of [JOB, EXT, SRC, DST]) await dropTestCollection(db, n);
  });

  it('the create_collection job fails and leaves no table', async () => {
    const err = await withRlsBroken(() => runCreateCollection(db, { name: JOB, fields: FIELDS }));
    expect(err?.message).toContain('zveltio_tenant_write_ok');
    expect(await exists(`zvd_${JOB}`)).toBe(false);
    expect(await DDLManager.getCollection(db, JOB)).toBeNull();
  });

  it("an extension's ctx.DDLManager.createCollection fails and leaves no table", async () => {
    const err = await withRlsBroken(() =>
      announcingDDLManager.createCollection(db, { name: EXT, fields: FIELDS }),
    );
    expect(err?.message).toContain('zveltio_tenant_write_ok');
    expect(await exists(`zvd_${EXT}`)).toBe(false);
  });

  it('a junction table fails and is not left behind', async () => {
    await runCreateCollection(db, { name: SRC, fields: FIELDS });
    await runCreateCollection(db, { name: DST, fields: FIELDS });
    const err = await withRlsBroken(() => DDLManager.createJunctionTable(db, SRC, DST));
    expect(err?.message).toContain('zveltio_tenant_write_ok');
    expect(await exists(JNC)).toBe(false);
  });

  it('the normal path creates the table with FORCE RLS and the tenant policy', async () => {
    // SRC and DST above, and the junction now that the function is back.
    await DDLManager.createJunctionTable(db, SRC, DST);
    for (const table of [`zvd_${SRC}`, `zvd_${DST}`, JNC]) {
      const r = await sql<{ rls: boolean; force: boolean; policy: boolean }>`
        SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
               EXISTS (SELECT 1 FROM pg_policy p
                        WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy
          FROM pg_class c WHERE c.oid = ${`public.${table}`}::regclass
      `.execute(db);
      expect(r.rows[0]).toEqual({ rls: true, force: true, policy: true });
    }
  });
});
