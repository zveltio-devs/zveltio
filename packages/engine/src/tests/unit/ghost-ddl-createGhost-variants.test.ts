/**
 * GhostDDL.createGhost — additional allowed DDL statement forms (ghost-ddl.ts).
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { GhostDDL } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

describe('GhostDDL.createGhost — DDL allowlist variants', () => {
  it('accepts DROP COLUMN IF EXISTS, ALTER COLUMN, and RENAME COLUMN', async () => {
    const db = new CannedDb();
    await GhostDDL.createGhost(asDb(db), 'zvd_items', [
      'DROP COLUMN IF EXISTS legacy',
      'ALTER COLUMN title TYPE text',
      'RENAME COLUMN sku TO code',
    ]);

    expect(
      db.executed(/ALTER TABLE "_zv_ghost_zvd_items" DROP COLUMN IF EXISTS legacy/),
    ).toHaveLength(1);
    expect(
      db.executed(/ALTER TABLE "_zv_ghost_zvd_items" ALTER COLUMN title TYPE text/),
    ).toHaveLength(1);
    expect(db.executed(/ALTER TABLE "_zv_ghost_zvd_items" RENAME COLUMN sku TO code/)).toHaveLength(
      1,
    );
  });
});
