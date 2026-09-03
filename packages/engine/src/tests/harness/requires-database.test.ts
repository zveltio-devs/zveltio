/**
 * Does this lane have a database to run against?
 *
 * `bun test src/tests/harness` exited 0 on a machine with no database, having
 * run nothing: every suite here guards itself with `harnessAvailable()`, so 281
 * files reported `0 pass, N skip, 0 fail` and the command reported success.
 * Measured, on one file:
 *
 *     $ DATABASE_URL= TEST_DATABASE_URL= bun test src/tests/harness/data-fk-violation.test.ts
 *     (skip) data foreign key violation (in-process)
 *      0 pass  3 skip  0 fail          ← exit 0
 *
 * CI always supplies a Postgres service, so CI was never lying — but the
 * documented local command was, and this repository has been bitten by that
 * shape twice already: the CI clone step that never cloned the extensions repo,
 * and `ext:ambient`, where the workflow comment records the lesson in one line —
 * "a skipped gate and a passing gate look identical in the summary".
 *
 * So the lane says so out loud instead. One failure, naming the fix, rather than
 * 281 silent skips wearing a green tick.
 *
 * The per-suite skips stay exactly as they were. They are what lets `bun test`
 * over the whole tree stay useful without a database, and they are honest at
 * file scope — it is the LANE's summary that was not. Same shape as
 * `check-insert-schema-match`, which refuses rather than passing when it has no
 * database to build against, and takes `ZVELTIO_ALLOW_MISSING_DB=1` from anyone
 * who means it.
 */

import { describe, expect, it } from 'bun:test';
import { harnessAvailable } from '../../testing/app-harness.js';

describe('harness lane', () => {
  it('has a database, or has been told on purpose that it does not', () => {
    if (process.env.ZVELTIO_ALLOW_MISSING_DB === '1') {
      // Deliberate: somebody ran the lane knowing it would skip. Nothing to
      // assert, and nothing pretending otherwise.
      return;
    }

    expect(
      harnessAvailable(),
      'No TEST_DATABASE_URL (or DATABASE_URL) is set, so every suite in ' +
        'src/tests/harness/ would skip and this lane would report success ' +
        'having run nothing.\n\n' +
        '  Point it at a migrated Postgres:\n' +
        '    TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/zveltio_test\n' +
        '  (scripts/setup-test-db.sh creates exactly that one.)\n\n' +
        '  Or, if skipping is what you meant: ZVELTIO_ALLOW_MISSING_DB=1',
    ).toBe(true);
  });
});
