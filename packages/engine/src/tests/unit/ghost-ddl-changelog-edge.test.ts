/**
 * Ghost DDL applyChangelog edge paths (lib/data/ghost-ddl.ts).
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

describe('applyChangelog edge cases', () => {
  it('upserts a row snapshot that contains only id (no-op UPDATE SET)', async () => {
    const db = new CannedDb();
    db.when(/FROM "_zv_changelog_zvd_orders"/, [
      { id: '1', operation: 'UPDATE', row_id: 'only-id', row_data: { id: 'only-id' } },
    ]);
    const applied = await GhostDDL.applyChangelog(asDb(db), MIGRATION);
    expect(applied).toBe(1);
    const upsert = db.executed(/INSERT INTO "_zv_ghost_zvd_orders"/)[0]!;
    expect(upsert.sql).toContain('"id" = EXCLUDED."id"');
  });
});
