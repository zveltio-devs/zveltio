/**
 * DDLManager.createCollection — unique field constraints (ddl-manager.ts).
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

describe('DDLManager.createCollection — unique fields', () => {
  it('adds a UNIQUE constraint DDL for fields marked unique', async () => {
    const db = new CannedDb();
    db.when(/SELECT EXISTS[\s\S]*pg_tables/i, [{ exists: false }]);
    await DDLManager.createCollection(asDb(db), {
      name: 'products',
      fields: [
        { name: 'sku', type: 'text', required: true, unique: true, indexed: false },
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
      ],
    } as never);
    expect(db.executed(/CREATE TABLE zvd_products/)[0]?.sql).toMatch(/"sku" text NOT NULL UNIQUE/);
  });
});
