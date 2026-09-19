/**
 * The scheduler claims its rows with FOR UPDATE SKIP LOCKED so that a second
 * replica polling the same second does not run the same flow. The claim was
 * severed: `_executeScheduledFlow` was dispatched WITHOUT `await` inside the
 * transaction callback, so the callback returned at once, the transaction
 * committed, and every row lock was released before the first step ran.
 *
 * Measured before the repair: two engine replicas, one due flow, two executions.
 *
 * Every other scheduler suite drives a `CannedDb` — no Postgres, therefore no
 * locks, therefore nothing that could ever have observed this. The probe below
 * asks the question the way a second replica would: with its OWN connection,
 * while the first one is mid-execution.
 */
import { expect, it } from 'bun:test';
import { _internalForTests, flowScheduler } from '../../lib/flows/flow-scheduler.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

it.skipIf(!harnessAvailable())(
  'a second replica cannot claim a flow that is mid-execution',
  async () => {
    const { db } = await getTestApp();
    const id = crypto.randomUUID();
    await db
      .insertInto('zv_flows' as never)
      .values({
        id,
        name: 'fencing probe',
        trigger_type: 'cron',
        trigger_config: JSON.stringify({ cron: '0 3 * * *' }),
        is_active: true,
        next_run_at: new Date(Date.now() - 60_000),
      } as never)
      .execute();

    // A separate connection is the whole point: two transactions on ONE
    // connection see each other's locks as their own and the probe would pass
    // with the defect in place.
    const replicaB = new Bun.SQL(process.env.TEST_DATABASE_URL!, { max: 1 });
    // An array, not a `let`: TypeScript narrows a variable assigned only
    // inside a callback to its initialiser type at the assertion below.
    const claimable: number[] = [];

    _internalForTests.setExecuteFlowForTests((async () => {
      const rows = await replicaB`
        SELECT id FROM zv_flows
        WHERE is_active = true AND trigger_type IN ('cron','ai_task')
          AND (next_run_at IS NULL OR next_run_at <= now())
        FOR UPDATE SKIP LOCKED`;
      claimable.push(rows.length);
      return { status: 'success', runId: 'fencing-probe' };
    }) as never);

    try {
      await flowScheduler.start(db);
      flowScheduler.stop(); // drop the timers, keep the db handle
      await flowScheduler._tick();
      expect(claimable).toEqual([0]);
    } finally {
      await replicaB.end();
      _internalForTests.setExecuteFlowForTests(null);
      await db.deleteFrom('zv_flows').where('id', '=', id).execute();
    }
  },
  30_000,
);
