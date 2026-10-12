/**
 * Statements on one transaction run in the order they are issued.
 *
 * `withCollectionRead` and `asSystemAs` both lean on this. They issue a read of
 * a transaction-local setting and the `set_config` calls that change it from
 * windows that overlap (`Promise.all`), without awaiting one before issuing the
 * next. A window's base is correct only if the read it issued first runs first,
 * and the last write issued is the value left behind only if it runs last.
 *
 * Both drivers are covered: CI runs the harness on Bun.SQL and again with
 * ZVELTIO_DB_DRIVER=pg.
 */
import { beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SETTING = 'zveltio.order_probe';

d('statements on one transaction', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
  });

  it('run in issue order when issued without awaiting', async () => {
    const seen = await db.transaction().execute(async (trx) => {
      // Even i writes i, odd i reads. A slow statement every few writes gives
      // a driver that dispatched out of order a window to show it.
      const issued = Array.from({ length: 60 }, (_, i) => {
        if (i % 2 === 1) {
          return sql<{ v: string | null }>`SELECT current_setting(${SETTING}, true) AS v`.execute(
            trx,
          );
        }
        const slow = i % 6 === 0 ? sql`, pg_sleep(0.01)` : sql``;
        return sql<{
          v: string | null;
        }>`SELECT set_config(${SETTING}, ${String(i)}, true) AS v${slow}`.execute(trx);
      });
      const results = await Promise.all(issued);
      const last = await sql<{
        v: string | null;
      }>`SELECT current_setting(${SETTING}, true) AS v`.execute(trx);
      return { results: results.map((r) => r.rows[0]?.v), last: last.rows[0]?.v };
    });

    seen.results.forEach((v, i) => {
      expect(v).toBe(String(i % 2 === 1 ? i - 1 : i));
    });
    expect(seen.last).toBe('58');
  });
});
