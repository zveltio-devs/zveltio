/**
 * DDLManager.introspectTable (lib/data/ddl-manager.ts) — pg type + FK mapping.
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

describe('DDLManager.introspectTable', () => {
  it('maps postgres column types and FK references to field configs', async () => {
    const db = new CannedDb();
    db.when(/FROM information_schema\.columns/i, [
      { column_name: 'title', data_type: 'text', udt_name: 'text', is_nullable: 'NO' },
      { column_name: 'active', data_type: 'boolean', udt_name: 'bool', is_nullable: 'YES' },
      { column_name: 'amount', data_type: 'numeric', udt_name: 'numeric', is_nullable: 'YES' },
      { column_name: 'payload', data_type: 'jsonb', udt_name: 'jsonb', is_nullable: 'YES' },
      { column_name: 'author_id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'YES' },
      { column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO' },
      {
        column_name: 'created_at',
        data_type: 'timestamp',
        udt_name: 'timestamptz',
        is_nullable: 'NO',
      },
    ]);
    db.when(/FROM information_schema\.table_constraints tc/i, [
      {
        column_name: 'author_id',
        foreign_table_name: 'zvd_authors',
      },
    ]);

    const fields = await DDLManager.introspectTable(asDb(db), 'articles');
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.title?.type).toBe('text');
    expect(byName.active?.type).toBe('boolean');
    expect(byName.amount?.type).toBe('number');
    expect(byName.payload?.type).toBe('json');
    expect(byName.author_id?.type).toBe('m2o');
    expect(
      (byName.author_id as { options?: { related_collection?: string } }).options
        ?.related_collection,
    ).toBe('authors');
    expect(fields.some((f) => f.name === 'id')).toBe(false);
    expect(fields.some((f) => f.name === 'created_at')).toBe(false);
  });

  it('maps array columns to tags', async () => {
    const db = new CannedDb();
    db.when(/FROM information_schema\.columns/i, [
      { column_name: 'labels', data_type: 'ARRAY', udt_name: '_text', is_nullable: 'YES' },
    ]);
    db.when(/FROM information_schema\.table_constraints tc/i, []);
    const fields = await DDLManager.introspectTable(asDb(db), 'tagged');
    expect(fields[0]?.name).toBe('labels');
    expect(fields[0]?.type).toBe('tags');
  });
});
