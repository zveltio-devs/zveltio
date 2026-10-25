/**
 * Two replicas booting together run one extension's pending migrations once.
 *
 * Boot (`loadFromDB` → `loadExtension`) runs an extension's migrations without
 * the extension lock the runtime paths hold. Two replicas booting onto one
 * database both read the chain as pending and both ran it: the second one's
 * transaction collided with the first's (23505 on the catalog or on
 * `zv_migrations.name`), so that replica failed the load and wrote its error
 * onto the shared registry row.
 *
 * Two calls on two pooled backends are two replicas here: the boot path has no
 * in-process lock either, so only Postgres can serialise them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { withExtensionLock } from '../../lib/extensions/extension-utils.js';
import { runExtensionMigrations } from '../../lib/extensions/migration-runner.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

const EXT = 'extbootrace';
const TABLE = `zv_${EXT}_rows`;
const DIR = `${process.env.TMPDIR ?? '/tmp'}/zv-extbootrace-${Date.now()}`;

d('extension migrations: concurrent boots run a pending chain once', () => {
  let db: Database;

  async function cleanup(): Promise<void> {
    await sql.raw(`DROP TABLE IF EXISTS ${TABLE}`).execute(db);
    await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${EXT}:%`}`.execute(db);
  }

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await cleanup();
    // The sleep holds the first transaction open while the second one starts.
    await Bun.write(
      `${DIR}/001_rows.sql`,
      `CREATE TABLE ${TABLE} (id serial PRIMARY KEY);\n` +
        `INSERT INTO ${TABLE} DEFAULT VALUES;\nSELECT pg_sleep(0.5);`,
    );
  }, 60_000);

  afterAll(async () => {
    if (db) await cleanup().catch(() => undefined);
    await Bun.$`rm -rf ${DIR}`.quiet().nothrow();
  });

  const ext = {
    name: EXT,
    getMigrations: () => [`${DIR}/001_rows.sql`],
  } as unknown as ZveltioExtension;

  async function ranOnce(runs: Promise<void>[]): Promise<void> {
    const outcomes = await Promise.allSettled(runs);
    const failed = outcomes.flatMap((o) => (o.status === 'rejected' ? [String(o.reason)] : []));
    expect(failed).toEqual([]);

    const seeded = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.raw(TABLE)}
    `.execute(db);
    expect(seeded.rows[0].n).toBe(1);
    const recorded = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM zv_migrations WHERE name LIKE ${`ext:${EXT}:%`}
    `.execute(db);
    expect(recorded.rows[0].n).toBe(1);
  }

  it('two boots: both loads succeed, the UP ran once and is recorded once', async () => {
    await ranOnce([runExtensionMigrations(ext, db), runExtensionMigrations(ext, db)]);
  }, 30_000);

  // A boot beside a runtime enable, which holds the `ext:<name>` lock on a pooled
  // connection of its own: run with DB_POOL_MAX=2 too, where a second holder deadlocks.
  it('a boot beside a runtime enable: the same, without a deadlock', async () => {
    await cleanup();
    await ranOnce([
      withExtensionLock(db, EXT, () => runExtensionMigrations(ext, db)),
      runExtensionMigrations(ext, db),
    ]);
  }, 30_000);
});
