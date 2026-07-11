/**
 * GhostDDL.atomicSwap — lock + rename sequence (lib/data/ghost-ddl.ts).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { cancelPendingCleanups, GhostDDL } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const MIGRATION = {
  originalTable: 'zvd_products',
  ghostTable: '_zv_ghost_zvd_products',
  changelogTable: '_zv_changelog_zvd_products',
  triggerName: '_zv_trg_ghost_zvd_products',
};

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

afterEach(() => {
  cancelPendingCleanups();
});

describe('GhostDDL.atomicSwap', () => {
  it('renames ghost to original inside a transaction lock', async () => {
    const db = new CannedDb();
    db.when(/FROM "_zv_changelog_zvd_products"/, []);

    await GhostDDL.atomicSwap(asDb(db), MIGRATION);

    expect(db.executed(/LOCK TABLE "zvd_products" IN SHARE ROW EXCLUSIVE/)).toHaveLength(1);
    expect(db.executed(/RENAME TO "_zv_old_zvd_products"/)).toHaveLength(1);
    expect(db.executed(/RENAME TO "zvd_products"/)).toHaveLength(1);
    expect(db.executed(/DROP TRIGGER IF EXISTS/)).toHaveLength(1);
  });
});
