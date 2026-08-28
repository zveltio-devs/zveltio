/**
 * `0A000` inside a transaction must propagate, not be replaced by `25P02`.
 *
 * The dialect retries a statement that failed with "cached plan must not change
 * result type". Outside a transaction that is right: every statement is its own,
 * so a second attempt — or the simple-query fallback — genuinely recovers.
 *
 * Inside one it cannot. The first failure has already aborted the transaction,
 * so the retry answers `25P02 current transaction is aborted`, `stillCached` is
 * false, and it is THAT error the dialect throws. The `0A000` never leaves the
 * file.
 *
 * The cost was not a lost retry, it was a lost cause: the request, the log and
 * Kysely's error hook all saw `25P02` and no failed statement before it — an
 * aborted transaction naming nothing. E2E failed that way in 8 of 19 runs, on a
 * different endpoint each time, and the SQL-error trace added to hunt it showed
 * exactly that shape.
 *
 * THIS IS A GUARD, NOT A BEHAVIOURAL TEST, and the difference is worth stating.
 * Provoking a real `0A000` needs a prepared plan whose result type changes under
 * it; three attempts against a live Postgres (prepare, `ALTER TABLE` from a
 * second connection, re-run on the same pooled backend) were all re-planned
 * cleanly instead. So this asserts the branch is present and correctly ordered,
 * and CI's SQL-error trace is what confirms the 25P02 stops appearing.
 */

import { describe, expect, it } from 'bun:test';

const SOURCE = await Bun.file(
  new URL('../../db/bun-sql-dialect.ts', import.meta.url).pathname,
).text();

describe('cached-plan retry', () => {
  it('refuses to retry inside a transaction, and only there', () => {
    const cachedPlanCheck = SOURCE.indexOf('if (!isCachedPlan) throw err;');
    const inTransactionGuard = SOURCE.indexOf('if (this.#inTransaction) throw err;');
    const retry = SOURCE.indexOf('return await runPrepared();', inTransactionGuard);

    expect(cachedPlanCheck, 'the 0A000 branch is gone — this guard is stale').toBeGreaterThan(-1);
    expect(inTransactionGuard, 'the in-transaction guard is gone').toBeGreaterThan(cachedPlanCheck);
    expect(retry, 'the retry no longer follows the guard').toBeGreaterThan(inTransactionGuard);
  });

  it('still falls back to simple-query when there is no transaction', () => {
    // `runInline` is the recovery that works, and it must stay reachable —
    // removing it would turn a recoverable stale plan into a failed request.
    expect(SOURCE).toContain('return runInline();');
  });
});
