/**
 * DDLManager.registerMetadata + updateCollectionMetadata (lib/data/ddl-manager.ts).
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

describe('DDLManager.registerMetadata', () => {
  it('inserts collection metadata with defaults', async () => {
    const db = new CannedDb();
    await DDLManager.registerMetadata(asDb(db), {
      name: 'catalog',
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    expect(db.executed(/insert into "zvd_collections"/i)).toHaveLength(1);
  });
});

describe('DDLManager.updateCollectionMetadata', () => {
  it('updates display name and serialized fields', async () => {
    const db = new CannedDb();
    await DDLManager.updateCollectionMetadata(asDb(db), 'catalog', {
      displayName: 'Product Catalog',
      fields: [{ name: 'sku', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    expect(db.executed(/update "zvd_collections" set/i)).toHaveLength(1);
    expect(db.executed(/display_name/i)).toHaveLength(1);
  });
});

describe('DDLManager.getTableDependents', () => {
  it('returns FK dependents from information_schema', async () => {
    const db = new CannedDb();
    db.when(/information_schema\.table_constraints/i, [
      {
        table: 'zvd_orders',
        constraint: 'orders_customer_fk',
        column: 'customer_id',
      },
    ]);
    const deps = await DDLManager.getTableDependents(asDb(db), 'customers');
    expect(deps).toHaveLength(1);
    expect(deps[0]?.column).toBe('customer_id');
  });
});
