/**
 * GhostDDL.applyChangelog — skip empty row_data snapshots (ghost-ddl.ts).
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

describe('GhostDDL.applyChangelog — empty snapshots', () => {
  it('skips INSERT rows with an empty object snapshot', async () => {
    const db = new CannedDb();
    db.when(/FROM "_zv_changelog_zvd_items"/, [
      { id: '1', operation: 'INSERT', row_id: 'empty', row_data: {} },
      { id: '2', operation: 'INSERT', row_id: 'ok', row_data: { id: 'ok', title: 'x' } },
    ]);

    const applied = await GhostDDL.applyChangelog(asDb(db), MIGRATION);
    expect(applied).toBe(1);
    expect(db.executed(/INSERT INTO "_zv_ghost_zvd_items"/)).toHaveLength(1);
  });
});
