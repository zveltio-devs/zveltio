/**
 * Deferred work waits for the COMMIT, not for a tick.
 *
 * Four places wrote to the pool after `next()` — the request log, the god audit,
 * the slow-query log and the row-rule policy refresh — and each was moved to
 * `setTimeout(…, 0)` on the reasoning that the transaction would be closed by
 * the next tick. An independent audit measured it and it is not: the timer fires
 * with the transaction still open, so the write takes a second pooled
 * connection, which is exactly what deferring was meant to prevent.
 *
 * A comment that promises a guarantee nothing enforces is worse than no comment,
 * because the next person builds on it. This pins the guarantee instead.
 */

import { describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import {
  getCurrentTenantTrx,
  onAfterCommit,
  withTenantIsolation,
} from '../../lib/tenancy/index.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;

d('after-commit work (in-process)', () => {
  it('runs with no transaction open, unlike a timer', async () => {
    const { db } = (await getTestApp()) as { db: Database };
    const tenant = (
      await sql<{ id: string }>`SELECT id FROM zv_tenants ORDER BY created_at LIMIT 1`.execute(db)
    ).rows[0]!.id;

    // Typed through a holder: TypeScript narrows a `let` assigned only inside a
    // callback to its initial value, and then refuses the comparison that is the
    // whole point of the test.
    const seen: { timer: boolean | null; hook: boolean | null } = { timer: null, hook: null };
    let hookRan = false;

    await withTenantIsolation(
      tenant,
      async () => {
        setTimeout(() => {
          if (seen.timer === null) seen.timer = getCurrentTenantTrx() !== undefined;
        }, 0);
        onAfterCommit(() => {
          hookRan = true;
          seen.hook = getCurrentTenantTrx() !== undefined;
        });
        // Long enough that the timer certainly fires while this is still running.
        await new Promise((r) => setTimeout(r, 25));
      },
      { userId: null },
    );

    expect(hookRan).toBe(true);
    // The measurement the audit made, kept as a test so the reasoning cannot
    // come back: a tick is not a commit.
    expect(seen.timer).toBe(true);
    expect(seen.hook).toBe(false);
  });

  it('runs immediately when there is no transaction to wait for', async () => {
    // Background jobs and boot reconcilers have no request transaction. Queuing
    // there would mean never running.
    let ran = false;
    onAfterCommit(() => {
      ran = true;
    });
    await Promise.resolve();
    expect(ran).toBe(true);
  });

  it('a failed follow-up does not take the request answer with it', async () => {
    const { db } = (await getTestApp()) as { db: Database };
    const tenant = (
      await sql<{ id: string }>`SELECT id FROM zv_tenants ORDER BY created_at LIMIT 1`.execute(db)
    ).rows[0]!.id;

    const answer = await withTenantIsolation(
      tenant,
      async () => {
        onAfterCommit(() => {
          throw new Error('planted: the audit log is wedged');
        });
        return 'the caller already has this';
      },
      { userId: null },
    );
    expect(answer).toBe('the caller already has this');
  });
});
