/**
 * DDLManager.dropCollection — FK dependent guard (ddl-manager.ts).
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
    { exists: String(q.parameters[0]) === 'zvd_authors' },
  ]);
  db.when(/FROM information_schema\.table_constraints/i, [
    {
      table_name: 'zvd_books',
      column_name: 'author_id',
      constraint_name: 'books_author_id_fkey',
    },
  ]);
  db.when(/from "zvd_relations"/i, []);
  return db;
}

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

beforeEach(() => {
  DDLManager.invalidateCache();
});

describe('DDLManager.dropCollection — FK guard', () => {
  it('throws listing dependents unless force=true', async () => {
    const db = setup();
    await expect(DDLManager.dropCollection(asDb(db), 'authors')).rejects.toThrow(
      /Cannot drop collection 'authors'/,
    );
    expect(db.executed(/DROP TABLE IF EXISTS zvd_authors/)).toHaveLength(0);
  });

  it('drops anyway when force=true', async () => {
    const db = setup();
    await DDLManager.dropCollection(asDb(db), 'authors', { force: true });
    expect(db.executed(/DROP TABLE IF EXISTS zvd_authors CASCADE/)).toHaveLength(1);
    expect(db.executed(/delete from "zvd_collections"/)).toHaveLength(1);
  });
});
