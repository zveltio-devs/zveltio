/**
 * DDLManager.introspectTable — boolean, json, tags array mappings (ddl-manager.ts).
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

describe('DDLManager.introspectTable — more pg types', () => {
  it('maps bool, jsonb, and array columns', async () => {
    const db = new CannedDb();
    db.when(/FROM information_schema\.columns/i, [
      { column_name: 'active', data_type: 'boolean', udt_name: 'bool', is_nullable: 'NO' },
      { column_name: 'meta', data_type: 'jsonb', udt_name: 'jsonb', is_nullable: 'YES' },
      { column_name: 'labels', data_type: 'ARRAY', udt_name: '_text', is_nullable: 'YES' },
    ]);
    db.when(/FROM information_schema\.table_constraints tc/i, []);

    const fields = await DDLManager.introspectTable(asDb(db), 'misc');
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.active?.type).toBe('boolean');
    expect(byName.active?.required).toBe(true);
    expect(byName.meta?.type).toBe('json');
    expect(byName.labels?.type).toBe('tags');
  });
});
