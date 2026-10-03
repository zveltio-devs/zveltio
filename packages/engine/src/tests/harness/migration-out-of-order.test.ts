/**
 * A migration numbered below the database's high-water mark is still applied.
 *
 * Two PRs each add a migration; the higher number merges first. Every database
 * that boots in between records 048, then 047 lands. Boot used to decide "is
 * anything pending?" by `last applied >= MAX_SCHEMA_VERSION` (48 >= 48) and
 * return before the runner ran, so 047 never reached any of those databases and
 * nothing said so. The runner itself checks file by file; the shortcut in front
 * of it compared numbers.
 *
 * Reproduced here by putting the database in exactly that state: 047's DOWN
 * run, its tracking row gone, 048 still recorded.
 */

import { describe, expect, it, spyOn } from 'bun:test';
import { sql } from 'kysely';
import { autoMigrate } from '../../db/auto-migrate.js';
import { createDb, type Database } from '../../db/index.js';
import { getLastAppliedMigration, runMigrations, runPending } from '../../db/migrations/index.js';
import { checkSchemaCompatibility } from '../../version.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const pinsPgTemp = sql<{ pinned: boolean }>`
  SELECT coalesce(array_to_string(proconfig, ',') LIKE '%pg_temp%', false) AS pinned
    FROM pg_proc WHERE oid = 'public.zveltio_sync_tombstone()'::regprocedure`;

/** 047 as it looked before it existed: its DOWN applied, no record of it. */
async function unapply047(db: Database): Promise<void> {
  await sql`ALTER FUNCTION public.zveltio_sync_tombstone() SET search_path = pg_catalog, public`.execute(
    db,
  );
  await sql`DELETE FROM zv_schema_versions WHERE version = 47`.execute(db);
}

d('migration applied below the high-water mark', () => {
  it('boot applies 047 on a database that already recorded 048', async () => {
    const { db } = await getTestApp();
    expect(await getLastAppliedMigration(db)).toBeGreaterThanOrEqual(48);
    expect((await pinsPgTemp.execute(db)).rows[0]?.pinned).toBe(true);

    await unapply047(db);
    expect((await pinsPgTemp.execute(db)).rows[0]?.pinned).toBe(false);

    try {
      const result = await autoMigrate(db);
      expect(result.ran).toBe(true);
      expect((await pinsPgTemp.execute(db)).rows[0]?.pinned).toBe(true);
      const row = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM zv_schema_versions
         WHERE version = 47 AND rolled_back_at IS NULL`.execute(db);
      expect(row.rows[0]?.n).toBe(1);

      // And the next boot finds nothing to do.
      expect((await autoMigrate(db)).ran).toBe(false);
    } finally {
      // The harness database is shared: never leave 047 missing behind a failure.
      await runPending(db);
    }
  }, 60_000);

  it('two runners started together apply the pending file once', async () => {
    // `zveltio migrate` beside a booting replica. Only boot took the lock; the
    // other runners both read 047 as pending and both ran it.
    const { db } = await getTestApp();
    const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
    const a = createDb(url);
    const b = createDb(url);
    await unapply047(db);
    try {
      const runs = await Promise.all([runMigrations(a), runMigrations(b)]);
      expect(runs.flat()).toEqual(['047_sync_tombstone_search_path.sql']);
      expect((await pinsPgTemp.execute(db)).rows[0]?.pinned).toBe(true);
    } finally {
      await runPending(db);
      await Promise.all([a.destroy(), b.destroy()]);
    }
  }, 60_000);

  it('with MIGRATIONS_AUTO=false a gap below the head reads as pending', async () => {
    const { app, db } = await getTestApp();
    const cookie = await createGodSession(app, db);
    await unapply047(db);
    const saved = process.env.MIGRATIONS_AUTO;
    process.env.MIGRATIONS_AUTO = 'false';
    const log = spyOn(console, 'log');
    try {
      expect((await autoMigrate(db)).ran).toBe(false);
      await checkSchemaCompatibility(db);
      expect(log.mock.calls.flat().join('\n')).toContain(
        '1 pending migration(s): 047_sync_tombstone_search_path.sql',
      );

      const res = await app.request('/api/health/version', { headers: { cookie } });
      expect(res.status).toBe(200);
      const { schema } = (await res.json()) as { schema: { pending: number; upToDate: boolean } };
      expect(schema).toMatchObject({ pending: 1, upToDate: false });
    } finally {
      log.mockRestore();
      if (saved === undefined) delete process.env.MIGRATIONS_AUTO;
      else process.env.MIGRATIONS_AUTO = saved;
      await runPending(db);
    }
  }, 60_000);
});
