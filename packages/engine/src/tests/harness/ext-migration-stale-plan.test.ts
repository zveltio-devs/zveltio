/**
 * An extension enabled on a RUNNING engine leaves no stale plan behind.
 *
 * `ai`'s migration adds columns to `zvd_collections`. Every pooled connection
 * that already prepared `DDLManager.getCollection`'s `select * from
 * "zvd_collections" where "name" = $1` then answers it with `0A000 cached plan
 * must not change result type` — inside a request transaction, a 500, on every
 * reuse. The boot recycles the pool after extension migrations; the runtime
 * enable path (`withExtensionLock` → `loadDynamic` → `runExtensionMigrations`)
 * and the purge path did not.
 *
 * Driven the way the enable route drives it: the migration runs under
 * `withExtensionLock`, whose holder transaction sits on the very pool a recycle
 * replaces, so this also proves the recycle does not kill a transaction still
 * open on the old pool.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { databaseDriver } from '../../db/pg-dialect.js';
import { withExtensionLock } from '../../lib/extensions/extension-utils.js';
import {
  purgeExtensionData,
  runExtensionMigrations,
} from '../../lib/extensions/migration-runner.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

// `pg` sends unnamed statements: no plan to go stale (see stale-plan-recycle).
const d = harnessAvailable() && databaseDriver() === 'bun' ? describe : describe.skip;

const EXT = 'extstaleplan';
const COL = 'zz_stale_plan_probe';
const DIR = `${process.env.TMPDIR ?? '/tmp'}/zv-extstaleplan-${Date.now()}`;
const POOL = Number(process.env.DB_POOL_MAX ?? 10);

d('extension migrations at run time: no pooled plan outlives them', () => {
  let db: Database;
  // Loaded after the app: a static import enters an import cycle at `register.ts`.
  let DDLManager: typeof import('../../lib/data/ddl-manager.js').DDLManager;
  let round = 0;

  /**
   * `getCollection` in POOL concurrent transactions, each held until all have
   * read: every pooled backend runs (and so prepares) the statement. A name
   * per call skips its cache. Returns the SQLSTATEs of the reads that failed.
   */
  async function readOnEveryConnection(): Promise<string[]> {
    round++;
    let arrived = 0;
    let open!: () => void;
    const allIn = new Promise<void>((r) => {
      open = r;
    });
    const failures: string[] = [];
    await Promise.all(
      Array.from({ length: POOL }, (_, i) =>
        db
          .transaction()
          .execute(async (trx) => {
            try {
              await DDLManager.getCollection(trx, `zz_probe_${round}_${i}`);
            } catch (err) {
              failures.push((err as { errno?: string }).errno ?? String(err));
            }
            if (++arrived === POOL) open();
            await allIn;
          })
          .catch(() => undefined),
      ),
    );
    return failures;
  }

  async function cleanup(): Promise<void> {
    await sql.raw(`ALTER TABLE zvd_collections DROP COLUMN IF EXISTS ${COL}`).execute(db);
    await sql`DELETE FROM zv_migrations WHERE name LIKE ${`ext:${EXT}:%`}`.execute(db);
  }

  const ext = {
    name: EXT,
    getMigrations: () => [`${DIR}/001_probe.sql`],
  } as unknown as ZveltioExtension;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    ({ DDLManager } = await import('../../lib/data/ddl-manager.js'));
    await cleanup();
    await Bun.write(
      `${DIR}/001_probe.sql`,
      `ALTER TABLE zvd_collections ADD COLUMN ${COL} text;\n-- DOWN\n` +
        `ALTER TABLE zvd_collections DROP COLUMN IF EXISTS ${COL};\n`,
    );
  }, 60_000);

  afterAll(async () => {
    if (db) await cleanup().catch(() => undefined);
    await Bun.$`rm -rf ${DIR}`.quiet().nothrow();
  });

  it('an enable that adds a column to an engine table', async () => {
    expect(await readOnEveryConnection()).toEqual([]);

    const t0 = Date.now();
    await withExtensionLock(db, EXT, () => runExtensionMigrations(ext, db));
    // The holder's transaction is still open while the pool is replaced: a
    // recycle that waits out a force-close would stall here and then kill it.
    expect(Date.now() - t0).toBeLessThan(4_000);

    expect(await readOnEveryConnection()).toEqual([]);
  }, 60_000);

  it('a connection acquired before the recycle runs its statement after it', async () => {
    // `db.connection()` holds one acquired connection across awaits; a recycle
    // in between closed the pool it had captured (ERR_POSTGRES_CONNECTION_CLOSED).
    const { recycleActivePool } = await import('../../db/index.js');
    const rows = await db.connection().execute(async (conn) => {
      await recycleActivePool();
      return (await sql<{ one: number }>`SELECT 1 AS one`.execute(conn)).rows;
    });
    expect(rows[0]?.one).toBe(1);
  }, 30_000);

  it('a purge whose DOWN drops that column again', async () => {
    expect(await readOnEveryConnection()).toEqual([]);
    await withExtensionLock(db, EXT, () => purgeExtensionData(EXT, db));
    expect(await readOnEveryConnection()).toEqual([]);
  }, 60_000);
});
