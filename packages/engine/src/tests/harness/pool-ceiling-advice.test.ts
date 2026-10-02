/**
 * The boot advice names the pool `initDatabase` built, not the fallback.
 *
 * With `DB_POOL_MAX` unset the pool is sized from the server, but
 * `reportConcurrencyCeiling` read `resolvePoolMax()` — the flat default. On a
 * server with max_connections=200 the engine built a pool of 60 and announced
 * "DB_POOL_MAX=40 ... so ~4 instance(s) fit" (3 do). That line is what an
 * operator sizes a deployment from (docs/platform/operations.md §3).
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import {
  _internalForTests as dbTesting,
  DEFAULT_DB_POOL_MAX,
  sizeBootPool,
} from '../../db/index.js';
import { reportConcurrencyCeiling } from '../../lib/startup-guards.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

// Sizes the pool without opening one: a second `initDatabase()` here, once
// destroyed, cleared the module-level pool handles the rest of the harness
// process relies on (stale-plan-recycle saw a null pool).
d('concurrency ceiling advice', () => {
  const saved = {
    DB_POOL_MAX: process.env.DB_POOL_MAX,
    DB_POOL_AUTOSIZE: process.env.DB_POOL_AUTOSIZE,
    ZVELTIO_INSTANCES: process.env.ZVELTIO_INSTANCES,
  };
  let previousMax: number | undefined;
  let logged: string[] = [];

  beforeAll(async () => {
    const { db } = await getTestApp();
    delete process.env.DB_POOL_MAX;
    delete process.env.DB_POOL_AUTOSIZE;
    // Enough instances that the autosized pool clamps to its floor, away from
    // the flat default whatever the server's max_connections.
    process.env.ZVELTIO_INSTANCES = '100000';
    previousMax = dbTesting.setPoolMaxInUse(undefined);
    const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logged.push(a.join(' '));
    });
    try {
      await sizeBootPool(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '');
      await reportConcurrencyCeiling(db);
    } finally {
      log.mockRestore();
    }
  });

  afterAll(() => {
    dbTesting.setPoolMaxInUse(previousMax);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    logged = [];
  });

  it('reports the autosized pool, not the fallback default', () => {
    const sized = logged.join('\n').match(/Pool sized from the server: DB_POOL_MAX=(\d+)/)?.[1];
    const advised = logged.join('\n').match(/Concurrency ceiling: DB_POOL_MAX=(\d+)/)?.[1];
    expect(sized).toBeDefined();
    expect(Number(sized)).not.toBe(DEFAULT_DB_POOL_MAX);
    expect(advised).toBe(sized);
  });
});
