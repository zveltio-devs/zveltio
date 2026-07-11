/**
 * GhostDDL.applyChangelog — DELETE operation path (lib/data/ghost-ddl.ts).
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { GhostDDL } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const MIGRATION = {
  originalTable: 'zvd_items',
  ghostTable: '_zv_ghost_zvd_items',
  changelogTable: '_zv_changelog_zvd_items',
  triggerName: '_zv_trg_ghost_zvd_items',
};

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

describe('GhostDDL.applyChangelog — DELETE', () => {
  it('deletes rows from the ghost table for DELETE changelog entries', async () => {
    const db = new CannedDb();
    db.when(/FROM "_zv_changelog_zvd_items"/, [
      { id: '1', operation: 'DELETE', row_id: 'row-42', row_data: null },
    ]);

    const applied = await GhostDDL.applyChangelog(asDb(db), MIGRATION);
    expect(applied).toBe(1);
    expect(db.executed(/DELETE FROM "_zv_ghost_zvd_items"/)).toHaveLength(1);
    expect(db.executed(/INSERT INTO "_zv_ghost_zvd_items"/)).toHaveLength(0);
  });
});
