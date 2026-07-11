/**
 * DDLManager.introspectTable — tsvector, float4, bare uuid (ddl-manager.ts).
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

describe('DDLManager.introspectTable — edge pg types', () => {
  it('maps tsvector, float4, and bare uuid columns', async () => {
    const db = new CannedDb();
    db.when(/FROM information_schema\.columns/i, [
      {
        column_name: 'body_vector',
        data_type: 'tsvector',
        udt_name: 'tsvector',
        is_nullable: 'YES',
      },
      { column_name: 'ratio', data_type: 'real', udt_name: 'float4', is_nullable: 'YES' },
      { column_name: 'token', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'YES' },
    ]);
    db.when(/FROM information_schema\.table_constraints tc/i, []);

    const fields = await DDLManager.introspectTable(asDb(db), 'edge');
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.body_vector?.type).toBe('text');
    expect(byName.ratio?.type).toBe('number');
    expect(byName.token?.type).toBe('uuid');
    expect(byName.token?.type).not.toBe('m2o');
  });

  it('ignores FK references to non-zvd tables', async () => {
    const db = new CannedDb();
    db.when(/FROM information_schema\.columns/i, [
      { column_name: 'owner_id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'YES' },
    ]);
    db.when(/FROM information_schema\.table_constraints tc/i, [
      { column_name: 'owner_id', foreign_table_name: 'user' },
    ]);

    const fields = await DDLManager.introspectTable(asDb(db), 'docs');
    expect(fields).toHaveLength(1);
    expect(fields[0]!.type).toBe('uuid');
    expect(fields[0]!.options).toBeUndefined();
  });
});
