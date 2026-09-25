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
  runWithDomain,
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

d('after-commit work queued late', () => {
  // A caller that does not await its own promise — `afterWrite` firing
  // `triggerDataFlows`, say — can reach `onAfterCommit` after the handler has
  // returned and the transaction has taken its queue. It is still inside the
  // transaction's async context, so it queued into an array nobody would read
  // again, and the work vanished without a word.
  async function tenantId(db: Database): Promise<string> {
    return (
      await sql<{ id: string }>`SELECT id FROM zv_tenants ORDER BY created_at LIMIT 1`.execute(db)
    ).rows[0]!.id;
  }

  type Seen = { value: boolean; trxVisible: boolean | null };

  /**
   * Starts work that queues its follow-up only after an await, and does not
   * wait for it. Awaiting a query on the transaction lands the follow-up
   * between the handler's return and the COMMIT (the driver runs the query
   * first); awaiting a timer lands it after the COMMIT.
   */
  function queueLate(trx: Database, after: 'query' | 'timer', seen: Seen): Promise<void> {
    return (async () => {
      if (after === 'query') await sql`SELECT pg_sleep(0.05)`.execute(trx).catch(() => {});
      else await new Promise((r) => setTimeout(r, 50));
      onAfterCommit(() => {
        seen.value = true;
        seen.trxVisible = getCurrentTenantTrx() !== undefined;
      });
    })();
  }

  for (const after of ['query', 'timer'] as const) {
    it(`runs after the commit when queued late (after a ${after})`, async () => {
      const { db } = (await getTestApp()) as { db: Database };
      const seen: Seen = { value: false, trxVisible: null };
      let late: Promise<void> | undefined;

      await withTenantIsolation(
        await tenantId(db),
        async (trx) => {
          late = queueLate(trx, after, seen);
        },
        { userId: null },
      );
      await late;
      await new Promise((r) => setTimeout(r, 10));

      expect(seen.value).toBe(true);
      // Outside the finished transaction, like the follow-ups queued in time.
      expect(seen.trxVisible).toBe(false);
    });

    it(`is dropped when the transaction rolls back (after a ${after})`, async () => {
      const { db } = (await getTestApp()) as { db: Database };
      const seen: Seen = { value: false, trxVisible: null };
      let late: Promise<void> | undefined;

      await expect(
        withTenantIsolation(
          await tenantId(db),
          async (trx) => {
            late = queueLate(trx, after, seen);
            throw new Error('planted: roll this back');
          },
          { userId: null },
        ),
      ).rejects.toThrow('planted');
      await late;
      await new Promise((r) => setTimeout(r, 10));

      expect(seen.value).toBe(false);
    });
  }

  it('runs when the store has a domain but no transaction', async () => {
    // A route the tenant middleware skips (`/api/collections`, `/api/flows`, …)
    // runs inside `runWithDomain` with no transaction. The request log and the
    // god audit queue there, and nothing drains that store.
    let ran = false;
    runWithDomain(await tenantId(((await getTestApp()) as { db: Database }).db), () => {
      onAfterCommit(() => {
        ran = true;
      });
    });
    await Promise.resolve();
    expect(ran).toBe(true);
  });
});
