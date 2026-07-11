/**
 * DDLManager.dropCollection force + dependents guard (lib/data/ddl-manager.ts).
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
    { exists: String(q.parameters[0]) === 'zvd_tags' },
  ]);
  db.when(/information_schema\.table_constraints/i, [
    {
      table: 'zvd_articles',
      constraint: 'articles_tag_fk',
      column: 'tag_id',
    },
  ]);
  db.when(
    /select "source_collection", "target_collection", "junction_table" from "zvd_relations"/i,
    [],
  );
  return db;
}

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

beforeEach(() => {
  DDLManager.invalidateCache();
});

describe('DDLManager.dropCollection — dependents', () => {
  it('refuses to drop when FK dependents exist without force', async () => {
    const db = setup();
    await expect(DDLManager.dropCollection(asDb(db), 'tags')).rejects.toThrow(
      'foreign key(s) reference it',
    );
    expect(db.executed(/DROP TABLE IF EXISTS zvd_tags CASCADE/)).toHaveLength(0);
  });

  it('drops the table when force=true even with dependents', async () => {
    const db = setup();
    await DDLManager.dropCollection(asDb(db), 'tags', { force: true });
    expect(db.executed(/DROP TABLE IF EXISTS zvd_tags CASCADE/)).toHaveLength(1);
    expect(db.executed(/delete from "zvd_collections"/i)).toHaveLength(1);
  });
});
