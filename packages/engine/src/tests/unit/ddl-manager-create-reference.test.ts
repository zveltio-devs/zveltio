/**
 * DDLManager.createCollection — reference field type mirrors m2o FK path (ddl-manager.ts).
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { DDLManager, fieldTypeRegistry } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

registerCoreFieldTypes(fieldTypeRegistry);

const TEXT = { name: 'title', type: 'text', required: true, unique: false, indexed: false };

function setup(existing: string[] = ['zvd_publishers']): CannedDb {
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

describe('DDLManager.createCollection — reference type', () => {
  it('creates an FK column for reference fields like m2o', async () => {
    const db = setup();
    await DDLManager.createCollection(asDb(db), {
      name: 'books',
      fields: [
        TEXT,
        {
          name: 'publisher',
          type: 'reference',
          required: false,
          unique: false,
          indexed: false,
          options: { related_collection: 'publishers', on_delete: 'SET NULL' },
        },
      ],
    } as never);

    expect(db.executed(/REFERENCES "zvd_publishers"/)).toHaveLength(1);
    expect(db.executed(/insert into "zvd_relations"/)).toHaveLength(1);
  });
});
