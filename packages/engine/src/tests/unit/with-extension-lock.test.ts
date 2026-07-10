/**
 * Cross-replica extension lifecycle lock (lib/extensions/extension-utils.ts).
 *
 * withExtensionLock composes inMemoryMutex + pg_advisory_xact_lock inside a
 * transaction. CannedDb exercises the SQL + fn body without Postgres.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { withExtensionLock } from '../../lib/extensions/extension-utils.js';
import { CannedDb } from './fixtures/canned-db.js';

describe('withExtensionLock', () => {
  it('runs fn inside a transaction after acquiring the advisory lock', async () => {
    const canned = new CannedDb();
    canned.when(/pg_advisory_xact_lock/i, []);
    const db = canned.kysely as unknown as Database;
    const seen: string[] = [];

    const out = await withExtensionLock(db, 'my-ext', async () => {
      seen.push('ran');
      return 42;
    });

    expect(out).toBe(42);
    expect(seen).toEqual(['ran']);
    expect(canned.executed(/pg_advisory_xact_lock/i).length).toBe(1);
  });

  it('serializes concurrent locks for the same extension name', async () => {
    const canned = new CannedDb();
    canned.when(/pg_advisory_xact_lock/i, []);
    const db = canned.kysely as unknown as Database;
    const order: string[] = [];

    const p1 = withExtensionLock(db, 'same-ext', async () => {
      order.push('a-start');
      await Bun.sleep(30);
      order.push('a-end');
    });
    await Promise.resolve();
    const p2 = withExtensionLock(db, 'same-ext', async () => {
      order.push('b');
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });
});
