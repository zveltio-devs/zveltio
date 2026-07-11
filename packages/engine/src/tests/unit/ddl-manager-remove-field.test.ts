/**
 * DDLManager.removeField (lib/data/ddl-manager.ts).
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { DDLManager, fieldTypeRegistry } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

registerCoreFieldTypes(fieldTypeRegistry);

function setup(): CannedDb {
  const db = new CannedDb();
  db.when(/SELECT EXISTS[\s\S]*pg_tables/i, (q) => [
    { exists: String(q.parameters[0]) === 'zvd_articles' },
  ]);
  db.when(/select \* from "zvd_collections" where "name" = /, [
    {
      name: 'articles',
      fields: JSON.stringify([
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'subtitle', type: 'text', required: false, unique: false, indexed: false },
      ]),
    },
  ]);
  return db;
}

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

beforeEach(() => {
  DDLManager.invalidateCache();
});

describe('DDLManager.removeField', () => {
  it('drops the column and removes the field from metadata', async () => {
    const db = setup();
    await DDLManager.removeField(asDb(db), 'articles', 'subtitle');
    expect(db.executed(/DROP COLUMN IF EXISTS "subtitle"/)).toHaveLength(1);
    expect(db.executed(/update "zvd_collections" set/)).toHaveLength(1);
  });

  it('rejects invalid field names', async () => {
    const db = setup();
    await expect(DDLManager.removeField(asDb(db), 'articles', 'Bad-Name')).rejects.toThrow(
      'Invalid field name',
    );
  });

  it('throws when the collection table is missing', async () => {
    const db = setup();
    db.when(/SELECT EXISTS[\s\S]*pg_tables/i, () => [{ exists: false }]);
    await expect(DDLManager.removeField(asDb(db), 'articles', 'subtitle')).rejects.toThrow(
      "Collection 'articles' not found",
    );
  });
});
