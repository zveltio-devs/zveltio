/**
 * DDLManager.introspectTable — additional pg type mappings (ddl-manager.ts).
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

describe('DDLManager.introspectTable — pg types', () => {
  it('maps date, datetime, and integer columns', async () => {
    const db = new CannedDb();
    db.when(/FROM information_schema\.columns/i, [
      { column_name: 'due', data_type: 'date', udt_name: 'date', is_nullable: 'YES' },
      {
        column_name: 'happened_at',
        data_type: 'timestamp with time zone',
        udt_name: 'timestamptz',
        is_nullable: 'YES',
      },
      { column_name: 'qty', data_type: 'bigint', udt_name: 'int8', is_nullable: 'YES' },
    ]);
    db.when(/FROM information_schema\.table_constraints tc/i, []);

    const fields = await DDLManager.introspectTable(asDb(db), 'events');
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(byName.due?.type).toBe('date');
    expect(byName.happened_at?.type).toBe('datetime');
    expect(byName.qty?.type).toBe('integer');
  });
});
