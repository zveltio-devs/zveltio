/**
 * The pool no longer ships one number to every server.
 *
 * A flat `DB_POOL_MAX` is wrong twice: it wastes a machine with 512 GB of RAM
 * and overcommits one with 8 GB. The tempting fix — measure the host and scale —
 * answers the wrong question, because a pooled connection is a backend process
 * on the DATABASE server and what bounds it is that server's `max_connections`,
 * a setting somebody chose, not free memory the engine can sense.
 *
 * So the size is derived from what the database says, with one number the engine
 * cannot know declared rather than guessed: how many instances share it.
 */

import { describe, expect, it } from 'bun:test';
import { autosizePool } from '../../db/pool-autosize.js';
import { harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const URL_ = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

/**
 * Set env vars for the duration of an ASYNC call.
 *
 * The first version of this was synchronous, and its `finally` restored the
 * environment the moment `fn()` returned its promise — before the function had
 * read a single variable. The engine has the same bug written up in
 * `tenant-context.ts`, where a synchronous `finally` dropped the tenant
 * transaction at the first `await` and every handler ran without one.
 */
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

d('pool autosizing (in-process)', () => {
  it('derives a size from the server, not from a constant', async () => {
    const sized = await withEnv({ ZVELTIO_INSTANCES: '1', DB_POOL_SHARE: undefined }, () =>
      autosizePool(URL_),
    );
    expect(sized).not.toBeNull();
    expect(sized!.max).toBeGreaterThanOrEqual(10);
    expect(sized!.max).toBeLessThanOrEqual(60);
    // The reason is printed at boot, so an operator can see the arithmetic
    // rather than infer it.
    expect(sized!.reason).toContain('max_connections');
  });

  it('divides by the declared number of instances', async () => {
    const one = await withEnv({ ZVELTIO_INSTANCES: '1', DB_POOL_SHARE: '1' }, () =>
      autosizePool(URL_),
    );
    const many = await withEnv({ ZVELTIO_INSTANCES: '8', DB_POOL_SHARE: '1' }, () =>
      autosizePool(URL_),
    );
    expect(one).not.toBeNull();
    expect(many).not.toBeNull();
    // Eight instances must not each be told they may have what one could have —
    // that is how a fleet exhausts a server under exactly the load that started
    // the extra replicas.
    expect(many!.max).toBeLessThanOrEqual(one!.max);
  });

  it('never goes below the floor, however many instances are declared', async () => {
    const sized = await withEnv({ ZVELTIO_INSTANCES: '10000' }, () => autosizePool(URL_));
    expect(sized).not.toBeNull();
    // A pool of one or two cannot serve at all — and a request needs its
    // transaction plus, on some paths, nothing more. Ten is the floor.
    expect(sized!.max).toBe(10);
  });

  it('ignores a nonsense share instead of computing nonsense', async () => {
    const bad = await withEnv({ DB_POOL_SHARE: 'not-a-number', ZVELTIO_INSTANCES: '1' }, () =>
      autosizePool(URL_),
    );
    const good = await withEnv({ DB_POOL_SHARE: '0.5', ZVELTIO_INSTANCES: '1' }, () =>
      autosizePool(URL_),
    );
    expect(bad!.max).toBe(good!.max);
  });

  it('answers null rather than throwing when it cannot ask', async () => {
    // A boot must not fail because sizing advice was unavailable.
    const sized = await autosizePool('postgresql://nobody:nobody@127.0.0.1:9/nothing');
    expect(sized).toBeNull();
  });
});
