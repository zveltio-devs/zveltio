/**
 * DDLManager.addField — m2o relation column on an existing collection.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { DDLManager, fieldTypeRegistry } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

registerCoreFieldTypes(fieldTypeRegistry);

function setup(existing: string[] = ['zvd_orders', 'zvd_customers']): CannedDb {
  const db = new CannedDb();
  db.when(/SELECT EXISTS[\s\S]*pg_tables/i, (q) => [
    { exists: existing.includes(String(q.parameters[0])) },
  ]);
  db.when(/select \* from "zvd_collections" where "name" = /, (q) => {
    const name = String(q.parameters[0]);
    if (name !== 'orders') return [];
    return [
      {
        name: 'orders',
        fields: JSON.stringify([
          { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        ]),
      },
    ];
  });
  return db;
}

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

beforeEach(() => {
  DDLManager.invalidateCache();
});

describe('DDLManager.addField — m2o relation', () => {
  it('adds an FK UUID column and appends relation metadata', async () => {
    const db = setup();
    await DDLManager.addField(asDb(db), 'orders', {
      name: 'customer',
      type: 'm2o',
      required: false,
      unique: false,
      indexed: true,
      options: { related_collection: 'customers', on_delete: 'SET NULL' },
    } as never);

    expect(db.executed(/ADD COLUMN IF NOT EXISTS "customer"/)).toHaveLength(1);
    expect(db.executed(/CREATE INDEX CONCURRENTLY.*customer/)).toHaveLength(1);
    expect(db.executed(/update "zvd_collections" set/)).toHaveLength(1);
  });

  it('skips metadata append when the field name already exists', async () => {
    const db = new CannedDb();
    db.when(/SELECT EXISTS[\s\S]*pg_tables/i, () => [{ exists: true }]);
    db.when(/select \* from "zvd_collections" where "name" = /, [
      {
        name: 'orders',
        fields: JSON.stringify([
          { name: 'title', type: 'text', required: true, unique: false, indexed: false },
          { name: 'customer', type: 'm2o', required: false, unique: false, indexed: false },
        ]),
      },
    ]);

    await DDLManager.addField(asDb(db), 'orders', {
      name: 'customer',
      type: 'm2o',
      required: false,
      unique: false,
      indexed: false,
      options: { related_collection: 'customers' },
    } as never);

    expect(db.executed(/update "zvd_collections" set/)).toHaveLength(0);
  });
});
