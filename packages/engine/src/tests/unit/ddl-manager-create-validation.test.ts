/**
 * DDLManager.createCollection — validation errors (ddl-manager.ts).
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

describe('DDLManager.createCollection — validation', () => {
  it('rejects unknown field types', async () => {
    const db = new CannedDb();
    db.when(/SELECT EXISTS[\s\S]*pg_tables/i, [{ exists: false }]);
    await expect(
      DDLManager.createCollection(asDb(db), {
        name: 'bad',
        fields: [
          { name: 'x', type: 'not_a_real_type', required: false, unique: false, indexed: false },
        ],
      } as never),
    ).rejects.toThrow('Unknown field type');
  });

  it('rejects m2o without related_collection', async () => {
    const db = new CannedDb();
    db.when(/SELECT EXISTS[\s\S]*pg_tables/i, [{ exists: false }]);
    await expect(
      DDLManager.createCollection(asDb(db), {
        name: 'orders',
        fields: [{ name: 'customer', type: 'm2o', required: false, unique: false, indexed: false }],
      } as never),
    ).rejects.toThrow('requires options.related_collection');
  });
});
