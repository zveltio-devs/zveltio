/**
 * The BYOD guard, on both paths that carry it.
 *
 * A BYOD collection is a table the customer brought themselves. The engine must
 * not run schema changes on it, and both DDL paths check `is_managed` before
 * they do anything.
 *
 * Both read it with `.catch(() => null)`, and `null` fell through to "no row
 * says otherwise, so proceed". A transient read error therefore DISABLED the
 * guard — at the one moment the answer was unknown, the code chose the
 * destructive branch.
 *
 * Ghost DDL is not a small operation to get wrong: it copies the table, applies
 * the DDL to the copy, backfills, and swaps. Doing that over a customer's own
 * table is exactly what the guard exists to prevent.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { GhostDDL } from '../../lib/data/ghost-ddl.js';
import { CannedDb } from './fixtures/canned-db.js';

describe('GhostDDL.execute — ownership cannot be read', () => {
  it('refuses to run, and says ownership is unknown rather than assuming managed', async () => {
    const db = new CannedDb();
    db.fail(/from "zvd_collections"/, new Error('connection terminated unexpectedly'));

    const phases: Array<[string, string]> = [];
    await GhostDDL.execute(
      db.kysely as unknown as Database,
      'zvd_customer_ledger',
      ['ADD COLUMN note TEXT'],
      (phase, detail) => phases.push([phase, detail]),
    );

    // Refused — and named as a skip with the reason, not as a completed run.
    expect(phases.some(([p]) => p === 'skipped')).toBe(true);
    expect(phases.some(([, d]) => /ownership is unknown/.test(d))).toBe(true);
    // Nothing was copied, altered or swapped.
    expect(db.executed(/CREATE TABLE/i)).toHaveLength(0);
  });

  it('still refuses an explicitly unmanaged table', async () => {
    // The ordinary BYOD case must keep working — the fix must not turn the guard
    // into "only refuse on errors".
    const db = new CannedDb();
    db.when(/from "zvd_collections"/, [{ is_managed: false }]);

    const phases: Array<[string, string]> = [];
    await GhostDDL.execute(
      db.kysely as unknown as Database,
      'zvd_byod_table',
      ['ADD COLUMN note TEXT'],
      (phase, detail) => phases.push([phase, detail]),
    );

    expect(phases.some(([, d]) => /unmanaged \(BYOD\)/.test(d))).toBe(true);
    expect(db.executed(/CREATE TABLE/i)).toHaveLength(0);
  });
});
