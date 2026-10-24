/**
 * A collection is created whole or not at all (its `zvd_relations` row stays
 * best-effort: a failure to write it is warned, as before).
 *
 * `createIsolatedTable` made only CREATE TABLE + tenant RLS atomic; the indexes,
 * triggers, `zvd_collections` row, relation FKs and junctions then ran as
 * separate statements on the pool. A failure among them (here: an m2o field's
 * `on_delete` that `applyRelationFK` refuses) left a committed `zvd_` table and
 * its metadata behind, and the create_collection job's retry then failed on
 * "already exists" forever.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import type { CollectionInput } from '../../lib/data/ddl-manager.js';
import { DDLManager, runCreateCollection } from '../../lib/data/index.js';
import { announcingDDLManager } from '../../lib/extensions/register.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = Date.now();
const DST = `atomic_dst_${SFX}`;
const JOB = `atomic_job_${SFX}`;
const EXT = `atomic_ext_${SFX}`;
const REL = `atomic_rel_${SFX}`;
const fields = (onDelete: string): CollectionInput['fields'] => [
  { name: 'title', type: 'text' },
  { name: 'owner', type: 'm2o', options: { related_collection: DST, on_delete: onDelete } },
  { name: 'tags', type: 'm2m', options: { related_collection: DST } },
];

d('collection create is atomic', () => {
  let db: Database;
  const exists = async (table: string) =>
    (
      await sql<{ t: string | null }>`SELECT to_regclass(${`public.${table}`})::text AS t`.execute(
        db,
      )
    ).rows[0]?.t != null;
  const failure = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: Error) => e,
    );

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await runCreateCollection(db, { name: DST, fields: [{ name: 'title', type: 'text' }] });
  });

  afterAll(async () => {
    if (!db) return;
    await sql.raw('DROP TRIGGER IF EXISTS zv_atomic_refuse ON zvd_relations').execute(db);
    await sql.raw('DROP FUNCTION IF EXISTS zv_atomic_refuse()').execute(db);
    for (const n of [JOB, EXT, REL, DST]) {
      await sql.raw(`DROP TABLE IF EXISTS "zvd_jnc_${n}_${DST}" CASCADE`).execute(db);
      await dropTestCollection(db, n);
    }
  });

  it('a create_collection job that fails late leaves nothing, and its retry succeeds', async () => {
    const err = await failure(runCreateCollection(db, { name: JOB, fields: fields('EXPLODE') }));
    expect(err?.message).toContain('Invalid on_delete');
    expect(await exists(`zvd_${JOB}`)).toBe(false);
    expect(await DDLManager.getCollection(db, JOB)).toBeNull();

    await runCreateCollection(db, { name: JOB, fields: fields('CASCADE') });
    expect(await exists(`zvd_${JOB}`)).toBe(true);
    expect(await exists(`zvd_jnc_${JOB}_${DST}`)).toBe(true);
    const fk = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE conrelid = ${`public.zvd_${JOB}`}::regclass AND contype = 'f'
         AND confrelid = ${`public.zvd_${DST}`}::regclass`.execute(db);
    expect(fk.rows[0]?.n).toBe(1);
    const trg = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_trigger
       WHERE tgrelid = ${`public.zvd_${JOB}`}::regclass AND tgname = ${`zvd_${JOB}_search_update`}`.execute(
      db,
    );
    expect(trg.rows[0]?.n).toBe(1);
    const grants = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zvd_permissions WHERE ptype = 'p' AND v2 = ${JOB}`.execute(db);
    expect(grants.rows[0]?.n).toBeGreaterThan(0);
  });

  it("an extension's ctx.DDLManager.createCollection that fails late leaves nothing", async () => {
    const err = await failure(
      announcingDDLManager.createCollection(db, { name: EXT, fields: fields('EXPLODE') }),
    );
    expect(err?.message).toContain('Invalid on_delete');
    expect(await exists(`zvd_${EXT}`)).toBe(false);
    expect(await DDLManager.getCollection(db, EXT)).toBeNull();
  });

  it('a relation row that cannot be written is warned about, as before, and the create commits', async () => {
    await sql
      .raw(`CREATE FUNCTION zv_atomic_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.source_collection = '${REL}' THEN RAISE EXCEPTION 'refused'; END IF;
        RETURN NEW; END $$`)
      .execute(db);
    await sql
      .raw(
        'CREATE TRIGGER zv_atomic_refuse BEFORE INSERT ON zvd_relations FOR EACH ROW EXECUTE FUNCTION zv_atomic_refuse()',
      )
      .execute(db);
    await runCreateCollection(db, { name: REL, fields: fields('CASCADE') });
    expect(await exists(`zvd_${REL}`)).toBe(true);
    expect(await DDLManager.getCollection(db, REL)).not.toBeNull();
  });
});
