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

  it('warns when relation metadata delete fails but still drops the table', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = setup(['zvd_notes']);
      db.when(/information_schema\.table_constraints/i, []);
      db.when(
        /select "source_collection", "target_collection", "junction_table" from "zvd_relations"/i,
        [],
      );
      db.fail(/delete from "zvd_relations"/, new Error('permission denied'));

      await DDLManager.dropCollection(asDb(db), 'notes');
      expect(warn.mock.calls.some((c) => String(c[0]).includes('relation metadata cleanup'))).toBe(
        true,
      );
      expect(db.executed(/DROP TABLE IF EXISTS zvd_notes CASCADE/)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
