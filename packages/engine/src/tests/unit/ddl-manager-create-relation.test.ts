/**
 * DDLManager.createCollection — m2o relation FK path (ddl-manager.ts).
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

describe('DDLManager.createCollection — m2o relation', () => {
  it('applies FK column and registers relation metadata when target exists', async () => {
    const db = new CannedDb();
    db.when(/SELECT EXISTS[\s\S]*pg_tables/i, (q) => {
      const table = String(q.parameters[0] ?? '');
      return [{ exists: table === 'zvd_customers' }];
    });

    await DDLManager.createCollection(asDb(db), {
      name: 'orders',
      fields: [
        { name: 'total', type: 'number', required: true, unique: false, indexed: false },
        {
          name: 'customer',
          type: 'm2o',
          required: false,
          unique: false,
          indexed: true,
          options: { related_collection: 'customers', on_delete: 'CASCADE' },
        },
      ],
    } as never);

    expect(db.executed(/ADD COLUMN IF NOT EXISTS "customer" UUID/)).toHaveLength(1);
    expect(db.executed(/insert into "zvd_relations"/i)).toHaveLength(1);
    expect(db.executed(/CREATE TABLE zvd_orders/)).toHaveLength(1);
  });
});
