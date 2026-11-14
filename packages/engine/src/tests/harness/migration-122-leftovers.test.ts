/**
 * Migration 122 drops what an abandoned online-copy run left (ADR 0041): the
 * copy, the swapped-out original, the changelog, and the changelog trigger and
 * its function on the live table — and leaves the live table as it was.
 *
 * The leftovers are planted as the deleted code built them, inside a
 * transaction that is rolled back, so the shared harness database keeps what
 * the migration chain left it.
 */

import { describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { parseMigrationFile } from '../../db/migrations/index.js';
import { catalogState, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ROLLBACK = new Error('rollback');
const X = `zz_m122_${Date.now()}`;
// Shaped like the prefixes with `_` read as LIKE's wildcard: must survive.
const LOOKALIKE = `azvbold_${X}`;

d('122 drops the leftovers of an abandoned table copy', () => {
  it('drops the copy, the old table, the changelog, the trigger and its function', async () => {
    const { db } = await getTestApp();
    const { up } = parseMigrationFile(
      await Bun.file(
        new URL('../../db/migrations/sql/122_drop_ghost_ddl_leftovers.sql', import.meta.url),
      ).text(),
    );
    let left: string[] = [];
    let untouched = false;
    let written = 0;
    const run = db.transaction().execute(async (trx) => {
      await sql`CREATE TABLE ${sql.id(X)} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text)`.execute(
        trx,
      );
      const before = await catalogState(trx, X);
      for (const t of [`_zv_ghost_${X}`, `_zv_old_${X}`, LOOKALIKE]) {
        await sql`CREATE TABLE ${sql.id(t)} (LIKE ${sql.id(X)} INCLUDING ALL)`.execute(trx);
      }
      await sql`CREATE TABLE ${sql.id(`_zv_changelog_${X}`)} (
        id bigserial PRIMARY KEY, operation text NOT NULL, row_id text NOT NULL, row_data jsonb)`.execute(
        trx,
      );
      await sql
        .raw(`
          CREATE FUNCTION "_zv_trg_ghost_${X}_fn"() RETURNS trigger
          SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
          BEGIN
            INSERT INTO "_zv_changelog_${X}" (operation, row_id, row_data)
            VALUES (TG_OP, NEW.id::text, to_jsonb(NEW));
            RETURN NEW;
          END $$ LANGUAGE plpgsql;
          CREATE TRIGGER "_zv_trg_ghost_${X}" AFTER INSERT OR UPDATE ON "${X}"
            FOR EACH ROW EXECUTE FUNCTION "_zv_trg_ghost_${X}_fn"();`)
        .execute(trx);

      await sql.raw(up).execute(trx);

      left = (
        await sql<{ n: string }>`
          SELECT relname AS n FROM pg_class
           WHERE relname IN (${`_zv_ghost_${X}`}, ${`_zv_old_${X}`}, ${`_zv_changelog_${X}`}, ${LOOKALIKE})
          UNION ALL
          SELECT proname FROM pg_proc WHERE proname = ${`_zv_trg_ghost_${X}_fn`}
          UNION ALL
          SELECT tgname FROM pg_trigger WHERE tgname = ${`_zv_trg_ghost_${X}`}`.execute(trx)
      ).rows.map((r) => r.n);
      untouched = JSON.stringify(await catalogState(trx, X)) === JSON.stringify(before);
      // A write to the live table no longer reaches for a changelog.
      written = Number(
        (await sql`INSERT INTO ${sql.id(X)} (title) VALUES ('after')`.execute(trx)).numAffectedRows,
      );
      throw ROLLBACK;
    });
    await expect(run).rejects.toBe(ROLLBACK);
    expect({ left, untouched, written }).toEqual({
      left: [LOOKALIKE],
      untouched: true,
      written: 1,
    });
  });
});
