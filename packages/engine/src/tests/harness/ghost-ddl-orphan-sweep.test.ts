/**
 * Ghost DDL leaves a full copy of the table behind, and nothing came back for it.
 *
 * The post-swap DROP is an in-process `setTimeout` sixty seconds out, and
 * `cancelPendingCleanups()` — which runs on graceful shutdown — cancels it. So
 * the loss does not need a crash: an ordinary deploy inside the window is
 * enough, and what survives is `_zv_old_<table>` plus its changelog, holding
 * every row the original held, without the tenant policies the live table has.
 *
 * The first test below reproduces exactly that before asserting the sweep
 * reclaims it — a sweep that passes without the loss first being real would be
 * proving nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  cancelPendingCleanups,
  DDLManager,
  GhostDDL,
  sweepGhostOrphans,
} from '../../lib/data/index.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const STAMP = Date.now();
const COLLECTION = `ghsweep_${STAMP}`;
const TABLE = `zvd_${COLLECTION}`;

/** Does a table exist in the schema the engine actually uses? */
async function exists(db: Database, name: string): Promise<boolean> {
  const r = await sql<{ n: number }>`
    SELECT COUNT(*)::int AS n FROM pg_tables
    WHERE schemaname = current_schema() AND tablename = ${name}
  `.execute(db);
  return (r.rows[0]?.n ?? 0) > 0;
}

d('Ghost DDL orphan sweep (in-process)', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
  });

  afterAll(async () => {
    if (!db) return;
    for (const t of [
      `_zv_old_${TABLE}`,
      `_zv_changelog_${TABLE}`,
      `_zv_ghost_${TABLE}`,
      `azvxoldy_${STAMP}`,
    ]) {
      await sql.raw(`DROP TABLE IF EXISTS "${t}" CASCADE`).execute(db);
    }
    // The collection itself: table AND the row that names it.
    await dropTestCollection(db, COLLECTION);
  });

  it('a shutdown inside the 60s window strands the copy — and the sweep reclaims it', async () => {
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    await sql.raw(`INSERT INTO "${TABLE}" (title) VALUES ('one'), ('two')`).execute(db);

    await GhostDDL.execute(db, TABLE, ['ADD COLUMN note TEXT']);

    // The swap has committed; the DROP is queued sixty seconds out. This is the
    // graceful shutdown that cancels it.
    cancelPendingCleanups();

    const oldTable = `_zv_old_${TABLE}`;
    expect(await exists(db, oldTable)).toBe(true);
    expect(await exists(db, TABLE)).toBe(true);

    // And it is not an empty husk — it holds the rows the original held.
    const stranded = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM ${sql.id(oldTable)}
    `.execute(db);
    expect(stranded.rows[0]?.n).toBe(2);

    const swept = await sweepGhostOrphans(db);

    expect(swept.dropped).toContain(oldTable);
    expect(swept.failed).toEqual([]);
    expect(await exists(db, oldTable)).toBe(false);
    expect(await exists(db, `_zv_changelog_${TABLE}`)).toBe(false);
    // The live table — the whole point of the swap — is untouched.
    expect(await exists(db, TABLE)).toBe(true);
    const live = await sql<{ n: number }>`
      SELECT COUNT(*)::int AS n FROM ${sql.id(TABLE)}
    `.execute(db);
    expect(live.rows[0]?.n).toBe(2);
  });

  it('leaves a ghost table alone — another instance may still be copying into it', async () => {
    const ghost = `_zv_ghost_${TABLE}`;
    await sql.raw(`CREATE TABLE "${ghost}" (id INT)`).execute(db);

    const swept = await sweepGhostOrphans(db);

    expect(swept.abandonedGhosts).toContain(ghost);
    expect(swept.dropped).not.toContain(ghost);
    expect(await exists(db, ghost)).toBe(true);
  });

  it('refuses a table name that is not a plain identifier', async () => {
    // The entry point is the cheapest place to close this: every statement below
    // interpolates the name, so a name that is not an identifier must never get
    // past here.
    for (const bad of ['users; DROP TABLE x', 'has space', '"quoted"', '1starts_with_digit']) {
      await expect(GhostDDL.execute(db, bad, ['ADD COLUMN z TEXT'])).rejects.toThrow(
        /Unsafe table name/,
      );
    }
  });

  it('reports a drop it could not do instead of pretending it swept', async () => {
    // A `DROP` can legitimately fail — something still depends on the table. The
    // sweep must say so rather than return a clean result, because a silent
    // failure here is how the orphans accumulated unnoticed in the first place.
    const stuck = `_zv_old_zvd_stuck_${STAMP}`;
    await sql.raw(`CREATE TABLE "${stuck}" (id INT)`).execute(db);
    await sql.raw(`CREATE VIEW "v_${stuck}" AS SELECT * FROM "${stuck}"`).execute(db);
    try {
      const swept = await sweepGhostOrphans(db);

      expect(swept.dropped).not.toContain(stuck);
      expect(swept.failed.map((f) => f.table)).toContain(stuck);
      expect(swept.failed.find((f) => f.table === stuck)?.reason).toBeTruthy();
      // And it is still there, which is the honest outcome.
      expect(await exists(db, stuck)).toBe(true);
    } finally {
      await sql.raw(`DROP VIEW IF EXISTS "v_${stuck}"`).execute(db);
      await sql.raw(`DROP TABLE IF EXISTS "${stuck}" CASCADE`).execute(db);
    }
  });

  it('does not treat the prefix underscores as LIKE wildcards', async () => {
    // `_zv_old_%` unescaped matches <any>zv<any>old<any> — this table among them.
    const decoy = `azvxoldy_${STAMP}`;
    await sql.raw(`CREATE TABLE "${decoy}" (id INT)`).execute(db);

    const swept = await sweepGhostOrphans(db);

    expect(swept.dropped).not.toContain(decoy);
    expect(await exists(db, decoy)).toBe(true);
  });
});
