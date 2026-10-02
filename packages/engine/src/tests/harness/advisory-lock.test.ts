/**
 * A boot-time advisory lock stays on one backend for as long as its work runs.
 *
 * `autoMigrate` took a SESSION `pg_advisory_lock` through `db.connection()`,
 * believing that pinned a connection. In this dialect it does not: outside a
 * transaction every statement goes to whichever pooled backend is free. The
 * unlock then landed on a different backend, returned false with a warning
 * nobody reads, and the lock stayed granted on an idle pooled connection — the
 * next replica to boot waited on it until something closed that connection.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import { createDb, type Database } from '../../db/index.js';
import {
  AdvisoryLockLost,
  AdvisoryLockTimeout,
  tryAdvisoryLock,
  withAdvisoryLock,
} from '../../db/advisory-lock.js';
import { autoMigrate } from '../../db/auto-migrate.js';
import { MAX_SCHEMA_VERSION } from '../../version.js';

const URL = process.env.TEST_DATABASE_URL;
const d = URL ? describe : describe.skip;
// 'zveltio\0' — the migration key; Postgres files a bigint key as (high, low).
const MIGRATION_KEY = 0x7a76656c74696f00n;
const HIGH = Number(MIGRATION_KEY >> 32n);
const LOW = Number(MIGRATION_KEY & 0xffffffffn);

d('advisory locks on the pool', () => {
  let db: Database;
  let probe: Database;

  /** Every backend holding or awaiting the migration lock. */
  const migrationLock = async () =>
    (
      await sql<{ pid: number; granted: boolean }>`
        SELECT pid, granted FROM pg_locks
         WHERE locktype = 'advisory' AND classid = ${HIGH} AND objid = ${LOW} AND objsubid = 1
      `.execute(probe)
    ).rows;

  const until = async (cond: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await cond()) return;
      await Bun.sleep(25);
    }
    throw new Error('timed out waiting');
  };

  beforeAll(() => {
    db = createDb(URL!);
    probe = createDb(URL!);
  });

  afterAll(async () => {
    await db.destroy();
    await probe.destroy();
  });

  it('autoMigrate releases the lock even when the pool rotated under it', async () => {
    const latest = await sql<Record<string, unknown>>`
      SELECT * FROM zv_schema_versions WHERE version = ${MAX_SCHEMA_VERSION}
    `.execute(probe);
    expect(latest.rows).toHaveLength(1);
    const row = latest.rows[0]!;
    const cols = Object.keys(row);

    // Another replica is migrating: it holds the key.
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    const other = probe.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(${MIGRATION_KEY})`.execute(trx);
      await released;
    });
    await until(async () => (await migrationLock()).some((l) => l.granted));

    // The first pooled backend is busy when autoMigrate asks for the lock, so
    // the lock is queued on the second one.
    const busy = sql`SELECT pg_sleep(0.6)`.execute(db);
    await Bun.sleep(100);
    await sql`DELETE FROM zv_schema_versions WHERE version = ${MAX_SCHEMA_VERSION}`.execute(probe);
    let migrated: Awaited<ReturnType<typeof autoMigrate>> | undefined;
    const run = autoMigrate(db).then((r) => {
      migrated = r;
    });
    try {
      await until(async () => (await migrationLock()).some((l) => !l.granted));
      await busy;
      // The other replica finishes the migration and lets go.
      await sql`
        INSERT INTO zv_schema_versions (${sql.join(cols.map((c) => sql.id(c)))})
        VALUES (${sql.join(cols.map((c) => row[c]))})
      `.execute(probe);
      release();
      await other;
      await run;
    } finally {
      release();
      await sql`
        INSERT INTO zv_schema_versions (${sql.join(cols.map((c) => sql.id(c)))})
        VALUES (${sql.join(cols.map((c) => row[c]))}) ON CONFLICT DO NOTHING
      `.execute(probe);
    }

    // It waited, re-checked, found the work done.
    expect(migrated).toMatchObject({ ran: false, after: MAX_SCHEMA_VERSION });
    // ...and left nothing behind for the next replica to wait on.
    expect(await migrationLock()).toEqual([]);
  }, 20_000);

  describe('withAdvisoryLock / tryAdvisoryLock', () => {
    let n = 0;
    /** A key no other test or engine uses: classid 0, objid = key. */
    const freshKey = () => BigInt(0x5a560000 + (Date.now() % 0xffff) * 16 + n++);
    const holders = async (key: bigint) =>
      (
        await sql<{ pid: number }>`
          SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted
             AND classid = 0 AND objid = ${Number(key)} AND objsubid = 1
        `.execute(probe)
      ).rows.map((r) => r.pid);
    const pid = async (on: Database) =>
      (await sql<{ p: number }>`SELECT pg_backend_pid() AS p`.execute(on)).rows[0]!.p;

    it('holds one backend for the whole callback, which the pool never borrows', async () => {
      const key = freshKey();
      let seen: { during: number[]; poolPids: number[] } | undefined;
      await withAdvisoryLock(db, key, async () => {
        const during = await holders(key);
        // Pool work beside the holder, sequential and concurrent.
        const poolPids = [await pid(db), ...(await Promise.all([1, 2, 3].map(() => pid(db))))];
        await Bun.sleep(50);
        seen = { during: [...during, ...(await holders(key))], poolPids };
      });
      expect(seen!.during).toHaveLength(2);
      expect(seen!.during[0]).toBe(seen!.during[1]!);
      expect(seen!.poolPids).not.toContain(seen!.during[0]);
      expect(await holders(key)).toEqual([]);
    });

    it('holds no snapshot, so CREATE INDEX CONCURRENTLY beside it does not wait on it', async () => {
      const table = `zv_advlock_cic_${Date.now()}`;
      await sql`CREATE TABLE ${sql.id(table)} (id int)`.execute(probe);
      try {
        for (const [run, key] of [
          [withAdvisoryLock, freshKey()],
          [tryAdvisoryLock, `zv-advlock-test-${Date.now()}`],
        ] as const) {
          const built = await run(db, key, async () => {
            const xmin = await sql<{ x: string | null }>`
              SELECT backend_xmin::text AS x FROM pg_stat_activity
               WHERE pid IN (SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted)
                 AND state = 'idle in transaction'
            `.execute(probe);
            await sql`CREATE INDEX CONCURRENTLY ${sql.id(`${table}_${typeof key}`)} ON ${sql.id(table)} (id)`.execute(
              db,
            );
            return xmin.rows;
          });
          expect(built).toEqual([{ x: null }]);
        }
      } finally {
        await sql`DROP TABLE ${sql.id(table)}`.execute(probe);
      }
    }, 20_000);

    it('a second caller waits for the first to finish', async () => {
      const key = freshKey();
      const order: string[] = [];
      let enter!: () => void;
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      const first = withAdvisoryLock(db, key, async () => {
        order.push('first:start');
        enter();
        await Bun.sleep(300);
        order.push('first:end');
      });
      await entered;
      await withAdvisoryLock(probe, key, async () => {
        order.push('second');
      });
      await first;
      expect(order).toEqual(['first:start', 'first:end', 'second']);
    });

    it('the try variant gives up at once while another holder has the key', async () => {
      const key = freshKey();
      let ran = false;
      const got = await withAdvisoryLock(probe, key, () =>
        tryAdvisoryLock(db, key, async () => {
          ran = true;
          return 'ran';
        }),
      );
      expect(got).toBeNull();
      expect(ran).toBe(false);
      expect(await tryAdvisoryLock(db, key, async () => 'ran')).toBe('ran');
    });

    it('maxWait ends the wait with AdvisoryLockTimeout, and only the wait', async () => {
      const key = freshKey();
      let ran = false;
      const t0 = Date.now();
      const err = await withAdvisoryLock(probe, key, () =>
        withAdvisoryLock(
          db,
          key,
          async () => {
            ran = true;
          },
          { maxWait: '200ms' },
        ).catch((e: unknown) => e),
      );
      expect(err).toBeInstanceOf(AdvisoryLockTimeout);
      expect(ran).toBe(false);
      expect(Date.now() - t0).toBeLessThan(5_000);
      // Free again, it is taken at once under the same bound.
      expect(await withAdvisoryLock(db, key, async () => 'ran', { maxWait: '200ms' })).toBe('ran');
    });

    it("maxWait, not the database's statement_timeout, decides how long a replica waits", async () => {
      // A statement_timeout an operator set on the database for queries used to
      // cancel a replica waiting for migrations — a restart loop with a bare
      // Postgres message. New connections pick the setting up; existing ones not.
      const dbName = (await sql<{ d: string }>`SELECT current_database() AS d`.execute(probe))
        .rows[0]!.d;
      await sql`ALTER DATABASE ${sql.id(dbName)} SET statement_timeout = '150ms'`.execute(probe);
      const strict = createDb(URL!);
      try {
        const key = freshKey();
        // Holds the key for 600 ms while `strict` waits for it; the waiter's
        // promise is returned after the hold ends, not awaited inside it.
        const wait = async (opts?: { maxWait: string }) => {
          let waiting!: Promise<unknown>;
          await withAdvisoryLock(probe, key, async () => {
            waiting = withAdvisoryLock(strict, key, async () => 'got', opts).catch(
              (e: unknown) => e,
            );
            await Bun.sleep(600);
          });
          return waiting;
        };
        // Without a bound of its own the server setting cancels the wait…
        expect(String(await wait())).toContain('statement timeout');
        // …with one, it waits the 600 ms out and takes the lock.
        expect(await wait({ maxWait: '5s' })).toBe('got');
      } finally {
        await strict.destroy();
        await sql`ALTER DATABASE ${sql.id(dbName)} RESET statement_timeout`.execute(probe);
      }
    }, 20_000);

    it('outlives the idle-in-transaction timeout the engine pool runs with', async () => {
      const u = new globalThis.URL(URL!);
      u.searchParams.set('options', '-c idle_in_transaction_session_timeout=300');
      const strict = createDb(u.toString());
      try {
        const key = freshKey();
        const out = await withAdvisoryLock(strict, key, async () => {
          const before = await holders(key);
          await Bun.sleep(900);
          return { before, after: await holders(key) };
        });
        expect(out.before).toHaveLength(1);
        expect(out.after).toEqual(out.before);
      } finally {
        await strict.destroy();
      }
    });

    describe('with a short pool idle timeout', () => {
      const saved = process.env.BUN_SQL_IDLE_TIMEOUT_MS;
      let short: Database;
      beforeAll(() => {
        // Bun closes a connection idle this long — a reserved one mid-transaction too.
        process.env.BUN_SQL_IDLE_TIMEOUT_MS = '1000';
        short = createDb(URL!);
      });
      afterAll(async () => {
        if (saved === undefined) delete process.env.BUN_SQL_IDLE_TIMEOUT_MS;
        else process.env.BUN_SQL_IDLE_TIMEOUT_MS = saved;
        await short.destroy();
      });

      it('keeps the holder alive past it', async () => {
        const key = freshKey();
        const out = await withAdvisoryLock(short, key, async () => {
          const before = await holders(key);
          await Bun.sleep(2500);
          // The beats left no snapshot behind either.
          const xmin = await sql<{ x: string | null }>`
            SELECT backend_xmin::text AS x FROM pg_stat_activity WHERE pid = ${before[0]!}
          `.execute(probe);
          return { before, after: await holders(key), xmin: xmin.rows };
        });
        expect(out.before).toHaveLength(1);
        expect(out.after).toEqual(out.before);
        expect(out.xmin).toEqual([{ x: null }]);
      }, 10_000);

      it('rejects when the holder dies under the work, and the pool still closes', async () => {
        const doomed = createDb(URL!);
        const key = freshKey();
        const err = await withAdvisoryLock(doomed, key, async () => {
          const [holder] = await holders(key);
          await sql`SELECT pg_terminate_backend(${holder!})`.execute(probe);
          await Bun.sleep(800);
          return 'done';
        }).then(
          () => null,
          (e: Error) => e,
        );
        expect(err).toBeInstanceOf(AdvisoryLockLost);
        // Bun's close() waited forever on the dead reserved connection.
        const closed = await Promise.race([
          doomed.destroy().then(() => 'closed'),
          Bun.sleep(8000).then(() => 'hung'),
        ]);
        expect(closed).toBe('closed');
      }, 15_000);
    });
  });
});
