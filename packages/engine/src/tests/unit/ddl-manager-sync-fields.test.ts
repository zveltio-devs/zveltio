/**
 * DDLManager.syncFieldsFromDB (lib/data/ddl-manager.ts).
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { DDLManager, fieldTypeRegistry } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

registerCoreFieldTypes(fieldTypeRegistry);

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

beforeEach(() => {
  DDLManager.invalidateCache();
});

describe('DDLManager.syncFieldsFromDB', () => {
  it('returns 0 when metadata already has fields', async () => {
    const db = new CannedDb();
    db.when(/select \* from "zvd_collections" where "name" = /, [
      {
        name: 'articles',
        fields: JSON.stringify([{ name: 'title', type: 'text' }]),
      },
    ]);
    const count = await DDLManager.syncFieldsFromDB(asDb(db), 'articles');
    expect(count).toBe(0);
  });

  it('introspects an empty-metadata collection and persists fields', async () => {
    const db = new CannedDb();
    db.when(/select \* from "zvd_collections" where "name" = /, [
      { name: 'articles', fields: JSON.stringify([]) },
    ]);
    db.when(/SELECT EXISTS[\s\S]*pg_tables/i, (q) => [
      { exists: String(q.parameters[0]) === 'zvd_articles' },
    ]);
    db.when(/FROM information_schema\.columns/i, [
      { column_name: 'title', data_type: 'text', udt_name: 'text', is_nullable: 'NO' },
      { column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO' },
    ]);
    db.when(/FROM information_schema\.table_constraints tc/i, []);

    const count = await DDLManager.syncFieldsFromDB(asDb(db), 'articles');
    expect(count).toBe(1);
    expect(db.executed(/update "zvd_collections" set/)).toHaveLength(1);
  });

  it('returns 0 when collection metadata is missing', async () => {
    const db = new CannedDb();
    db.when(/select \* from "zvd_collections" where "name" = /, []);
    const count = await DDLManager.syncFieldsFromDB(asDb(db), 'missing');
    expect(count).toBe(0);
  });

  it('returns 0 when metadata is empty but the physical table is missing', async () => {
    const db = new CannedDb();
    db.when(/select \* from "zvd_collections" where "name" = /, [
      { name: 'orphan', fields: JSON.stringify([]) },
    ]);
    db.when(/SELECT EXISTS[\s\S]*pg_tables/i, [{ exists: false }]);
    const count = await DDLManager.syncFieldsFromDB(asDb(db), 'orphan');
    expect(count).toBe(0);
    expect(db.executed(/information_schema\.columns/)).toHaveLength(0);
  });

  it('returns 0 when introspection yields only system columns', async () => {
    const db = new CannedDb();
    db.when(/select \* from "zvd_collections" where "name" = /, [
      { name: 'orphan', fields: JSON.stringify([]) },
    ]);
    db.when(/SELECT EXISTS[\s\S]*pg_tables/i, [{ exists: true }]);
    db.when(/FROM information_schema\.columns/i, [
      { column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO' },
      { column_name: 'tenant_id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO' },
    ]);
    db.when(/FROM information_schema\.table_constraints tc/i, []);
    const count = await DDLManager.syncFieldsFromDB(asDb(db), 'orphan');
    expect(count).toBe(0);
    expect(db.executed(/update "zvd_collections" set/)).toHaveLength(0);
  });
});
