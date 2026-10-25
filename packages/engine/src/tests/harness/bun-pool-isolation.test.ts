/**
 * A statement outside a transaction never runs inside someone else's.
 *
 * `Bun.SQL` 1.3.14 pipelines `pool.unsafe()` statements onto a connection it
 * has just handed to a waiting `reserve()`, once demand passes `max` (see
 * `#run` in db/bun-sql-dialect.ts). A plain read then saw another caller's
 * `SET LOCAL` setting, and within a few bursts the pool stalled until the 35 s
 * acquire deadline. The dialect reserves a connection per statement, so neither
 * can happen. Fails on the old dialect: a leak or `HANG` within a few bursts.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { Kysely, sql } from 'kysely';
import { BunSqlDialect } from '../../db/bun-sql-dialect.js';
import { harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('Bun.SQL pool isolation', () => {
  const db = new Kysely<any>({
    dialect: new BunSqlDialect({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }),
  });
  afterAll(() => db.destroy());

  it('more callers than connections: no leak into a transaction, no stall', async () => {
    let leaks = 0;
    const caller = async (n: number) => {
      for (let k = 0; k < 2; k++) {
        const { rows } = await sql<{
          m: string | null;
        }>`SELECT current_setting('zv.probe', true) AS m, ${n}::int AS n`.execute(db);
        if (rows[0].m) leaks++;
      }
      await db.transaction().execute(async (tx) => {
        await sql`SELECT set_config('zv.probe', ${`tx${n}`}, true)`.execute(tx);
        await sql`SELECT pg_sleep(0.002)`.execute(tx);
      });
    };
    for (let burst = 0; burst < 15; burst++) {
      const outcome = await Promise.race([
        Promise.all(Array.from({ length: 16 }, (_, n) => caller(n))).then(() => 'ok'),
        Bun.sleep(8_000).then(() => 'HANG'),
      ]);
      expect(`${outcome} at burst ${burst}`).toBe(`ok at burst ${burst}`);
    }
    expect(leaks).toBe(0);
  }, 20_000);

  it('a reserved statement still runs several commands, and refuses a raw BEGIN', async () => {
    await sql.raw('SELECT 1; SELECT 2').execute(db);
    await expect(sql`BEGIN`.execute(db)).rejects.toThrow(/db\.transaction/);
  });
});
