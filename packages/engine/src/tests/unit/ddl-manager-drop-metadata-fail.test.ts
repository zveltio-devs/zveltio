/**
 * DDLManager.dropCollection — invalid junction skip + relation cleanup failure (ddl-manager.ts).
 */

import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { DDLManager, fieldTypeRegistry } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

registerCoreFieldTypes(fieldTypeRegistry);

function setup(existing: string[] = []): CannedDb {
  const db = new CannedDb();
  db.when(/SELECT EXISTS[\s\S]*pg_tables/i, (q) => [
    { exists: existing.includes(String(q.parameters[0])) },
  ]);
  return db;
}

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

beforeEach(() => {
  DDLManager.invalidateCache();
});

describe('DDLManager.dropCollection — metadata edge cases', () => {
  it('skips junction drop when junction_table name fails the safe regex', async () => {
    const db = setup(['zvd_notes']);
    db.when(/information_schema\.table_constraints/i, []);
    db.when(
      /select "source_collection", "target_collection", "junction_table" from "zvd_relations"/i,
      [
        {
          source_collection: 'notes',
          target_collection: 'tags',
          junction_table: 'not_a_valid_name',
        },
      ],
    );

    await DDLManager.dropCollection(asDb(db), 'notes');
    expect(db.executed(/DROP TABLE IF EXISTS "not_a_valid_name"/)).toHaveLength(0);
    expect(db.executed(/DROP TABLE IF EXISTS zvd_notes CASCADE/)).toHaveLength(1);
  });

  /**
   * This asserted "warns but still drops", and that was the defect. Warning past
   * the metadata delete leaves `zvd_relations` rows pointing at a collection that
   * no longer exists — ghost relations in the schema view — and the row that
   * would have told an operator what happened is the row that failed to write.
   */
  it('refuses rather than dropping the table and leaving orphan relation metadata', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = setup(['zvd_notes']);
      db.when(/information_schema\.table_constraints/i, []);
      db.when(
        /select "source_collection", "target_collection", "junction_table" from "zvd_relations"/i,
        [],
      );
      db.fail(/delete from "zvd_relations"/, new Error('permission denied'));

      await expect(DDLManager.dropCollection(asDb(db), 'notes')).rejects.toThrow(
        /permission denied/,
      );
      // The table IS already dropped here — the metadata delete runs after it —
      // so the throw is what stops `zvd_collections` from being deleted too,
      // leaving a row that says the collection still exists and an operator who
      // can see something went wrong.
      expect(db.executed(/DROP TABLE IF EXISTS zvd_notes CASCADE/)).toHaveLength(1);
      expect(db.executed(/delete from "zvd_collections"/i)).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});
