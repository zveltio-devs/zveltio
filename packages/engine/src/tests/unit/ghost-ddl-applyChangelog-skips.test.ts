/**
 * GhostDDL.applyChangelog — skip null/empty snapshots (ghost-ddl.ts).
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { GhostDDL } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const MIGRATION = {
  originalTable: 'zvd_orders',
  ghostTable: '_zv_ghost_zvd_orders',
  changelogTable: '_zv_changelog_zvd_orders',
  triggerName: '_zv_trg_ghost_zvd_orders',
};

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

describe('applyChangelog — skipped snapshots', () => {
  it('does not upsert INSERT rows with null or empty row_data', async () => {
    const db = new CannedDb();
    db.when(/FROM "_zv_changelog_zvd_orders"/, [
      { id: '1', operation: 'INSERT', row_id: 'a', row_data: null },
      { id: '2', operation: 'INSERT', row_id: 'b', row_data: {} },
      { id: '3', operation: 'INSERT', row_id: 'c', row_data: { id: 'c', total: 1 } },
    ]);

    const applied = await GhostDDL.applyChangelog(asDb(db), MIGRATION);
    expect(applied).toBe(1);
    expect(db.executed(/INSERT INTO "_zv_ghost_zvd_orders"/)).toHaveLength(1);
  });
});
