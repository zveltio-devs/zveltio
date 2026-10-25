import { describe, it, expect, beforeEach, afterEach, setSystemTime } from 'bun:test';

/**
 * Unit tests for the auto-migrate skip + advisory-lock path (S4-10).
 *
 * `autoMigrate(db)` does I/O against Postgres — running it for real
 * requires a live database. Here we test the *decision* logic:
 *   - `MIGRATIONS_AUTO=false` short-circuits early.
 *   - Every shipped migration recorded → no lock, no migrations.
 *
 * The lock itself is covered against a real Postgres in
 * `tests/harness/advisory-lock.test.ts`. Here we
 * exercise the early-exit branches with a stub DB.
 */

import { join } from 'path';
import type { Database } from '../../db/index.js';

import { MAX_SCHEMA_VERSION } from '../../version.js';
import { CannedDb } from './fixtures/canned-db.js';

type Row = { version: number; filename: string; checksum: string };

/** Every migration this build ships, recorded as applied ('baseline' skips the checksum compare). */
const SHIPPED: Row[] = [
  ...new Bun.Glob('{sql,baseline}/*.sql').scanSync({
    cwd: join(import.meta.dir, '../../db/migrations'),
  }),
]
  .map((path) => path.slice(path.indexOf('/') + 1))
  .map((filename) => ({ version: parseInt(filename, 10), filename, checksum: 'baseline' }))
  .sort((a, b) => a.version - b.version);

/**
 * The real autoMigrate over a CannedDb. This file used to re-implement the
 * decision logic and the lock key locally and assert the copies, so neither
 * could drift without the test noticing. `chains` answers successive reads of
 * the recorded chain (the first read, then the re-check under the lock).
 */
async function run(env: string | undefined, chains: Row[][]) {
  const saved = process.env.MIGRATIONS_AUTO;
  if (env === undefined) delete process.env.MIGRATIONS_AUTO;
  else process.env.MIGRATIONS_AUTO = env;
  const db = new CannedDb();
  db.when(/server_version_num/i, [{ v: '180000' }]);
  let read = 0;
  db.when(/from "zv_schema_versions"/i, [{ version: MAX_SCHEMA_VERSION }]);
  db.when(
    /select version, filename, checksum from zv_schema_versions/i,
    () => chains[Math.min(read++, chains.length - 1)]!,
  );
  db.when(/pg_try_advisory_xact_lock/i, [{ ok: true }]);
  try {
    const { autoMigrate } = await import('../../db/auto-migrate.js');
    const result = await autoMigrate(db.kysely as unknown as Database);
    return { result, db };
  } finally {
    if (saved === undefined) delete process.env.MIGRATIONS_AUTO;
    else process.env.MIGRATIONS_AUTO = saved;
  }
}

describe('S4-10 auto-migrate decision logic', () => {
  it('skips without taking the lock when every shipped migration is recorded', async () => {
    const ahead = [
      ...SHIPPED,
      { version: MAX_SCHEMA_VERSION + 1, filename: 'x.sql', checksum: 'x' },
    ];
    for (const chain of [SHIPPED, ahead]) {
      const { result, db } = await run(undefined, [chain]);
      expect(result.ran).toBe(false);
      expect(result.before).toBe(chain.at(-1)!.version);
      // One read decides it: no second trip to the database when nothing is pending.
      expect(db.executed(/./)).toHaveLength(1);
    }
  });

  it('takes the lock when a migration below the high-water mark was never applied', async () => {
    // 048 recorded, 047 merged after it: `last applied >= MAX` said up to date.
    const gap = SHIPPED.filter((_, i) => i !== SHIPPED.length - 2);
    const { result, db } = await run(undefined, [gap, SHIPPED]);
    expect(result.before).toBe(MAX_SCHEMA_VERSION);
    expect(db.executed(/pg_try_advisory_xact_lock/i)).toHaveLength(1);
    expect(result.ran).toBe(false); // the re-check under the lock found it applied
  });

  it('only treats the literal string "false" as opt-out', async () => {
    // Common typos must not disable auto-migrate: they reach the chain check,
    // which the opt-out path returns before.
    for (const env of ['0', 'False', 'no', '']) {
      const { db } = await run(env, [SHIPPED]);
      expect(db.executed(/select version, filename, checksum/i).length).toBeGreaterThan(0);
    }
    const { db } = await run('false', [SHIPPED]);
    expect(db.executed(/select version, filename, checksum/i)).toHaveLength(0);
  });
});

describe('S4-10 advisory lock', () => {
  it('locks every replica on the same key and re-checks under it', async () => {
    // Pending on the first read; another replica finished while we waited.
    const { result, db } = await run(undefined, [SHIPPED.slice(0, -1), SHIPPED]);
    expect(result.ran).toBe(false);
    expect(result.after).toBe(MAX_SCHEMA_VERSION);
    const lock = db.executed(/pg_try_advisory_xact_lock/i);
    expect(lock).toHaveLength(1);
    // 'zveltio\0' as a big-endian 64-bit integer — every replica must agree on it.
    expect(lock[0]!.sql).toBe('SELECT pg_try_advisory_xact_lock(8824352036363005696) AS ok');
    expect(8824352036363005696n).toBe(0x7a76656c74696f00n);
    // Transaction-scoped: nothing to unlock, and nothing a pooled backend can keep.
    expect(db.executed(/pg_advisory_unlock/i)).toHaveLength(0);
  });
});

describe('migration lock wait', () => {
  /** A pending schema whose lock another replica keeps past the wait. */
  async function waitOut(wait: string | undefined) {
    const saved = process.env.ZVELTIO_MIGRATION_LOCK_WAIT;
    if (wait === undefined) delete process.env.ZVELTIO_MIGRATION_LOCK_WAIT;
    else process.env.ZVELTIO_MIGRATION_LOCK_WAIT = wait;
    const db = new CannedDb();
    db.when(/server_version_num/i, [{ v: '180000' }]);
    db.when(/from "zv_schema_versions"/i, [{ version: MAX_SCHEMA_VERSION - 1 }]);
    db.when(/select version, filename, checksum from zv_schema_versions/i, []);
    // Held elsewhere; and each try finds the clock an hour on, past any bound.
    db.when(/pg_try_advisory_xact_lock/i, () => {
      setSystemTime(new Date(Date.now() + 3_600_000));
      return [{ ok: false }];
    });
    try {
      const { autoMigrate } = await import('../../db/auto-migrate.js');
      const err = await autoMigrate(db.kysely as unknown as Database).catch((e: unknown) => e);
      return { err: err as Error, db };
    } finally {
      setSystemTime();
      if (saved === undefined) delete process.env.ZVELTIO_MIGRATION_LOCK_WAIT;
      else process.env.ZVELTIO_MIGRATION_LOCK_WAIT = saved;
    }
  }

  it('bounds the wait on its own terms and names the setting when it runs out', async () => {
    const { err, db } = await waitOut(undefined);
    // The deadline, not a server statement_timeout, ended it: one try, then out.
    expect(db.executed(/pg_try_advisory_xact_lock/i)).toHaveLength(1);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('more than 10min');
    expect(err.message).toContain('ZVELTIO_MIGRATION_LOCK_WAIT');
  });

  it('takes the bound from ZVELTIO_MIGRATION_LOCK_WAIT, and refuses a malformed one', async () => {
    const { err } = await waitOut('45s');
    expect(err.message).toContain('more than 45s');
    const bad = await waitOut('ten minutes');
    expect(bad.err.message).toContain('ZVELTIO_MIGRATION_LOCK_WAIT="ten minutes"');
    expect(bad.db.executed(/pg_try_advisory_xact_lock/i)).toHaveLength(0);
  });
});

describe('S4-10 autoMigrate — integration with stub db (env path)', () => {
  // This exercises the real autoMigrate against a stub that records
  // calls. We verify MIGRATIONS_AUTO=false skips ALL DB calls (no
  // pg_advisory_lock, no SELECT).

  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.MIGRATIONS_AUTO;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MIGRATIONS_AUTO;
    else process.env.MIGRATIONS_AUTO = originalEnv;
  });

  it('with MIGRATIONS_AUTO=false: returns ran:false and never touches the lock', async () => {
    process.env.MIGRATIONS_AUTO = 'false';
    const calls: string[] = [];
    const db: any = {
      selectFrom: (table: string) => {
        calls.push(`selectFrom:${table}`);
        return {
          select: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => ({
                  executeTakeFirst: async () => ({ version: 42 }),
                }),
              }),
            }),
          }),
        };
      },
    };
    const { autoMigrate } = await import('../../db/auto-migrate.js');
    const result = await autoMigrate(db as Database);
    expect(result.ran).toBe(false);
    expect(result.before).toBe(42);
    expect(result.after).toBe(42);
    // selectFrom was called once for `getLastAppliedMigration` — that's it.
    // No SELECT pg_advisory_lock.
    expect(calls.some((c) => c.includes('advisory_lock'))).toBe(false);
  });
});
