/**
 * DDLManager.addField — indexed + unique constraints (ddl-manager.ts).
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

describe('DDLManager.addField — indexes', () => {
  it('adds concurrent index DDL when field.indexed is true', async () => {
    const db = new CannedDb();
    db.when(/SELECT EXISTS[\s\S]*pg_tables/i, [{ exists: true }]);
    db.when(/select \* from "zvd_collections" where "name" = /, [
      {
        name: 'products',
        fields: JSON.stringify([
          { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        ]),
      },
    ]);
    await DDLManager.addField(asDb(db), 'products', {
      name: 'sku',
      type: 'text',
      required: true,
      unique: true,
      indexed: true,
    } as never);
    expect(db.executed(/CREATE INDEX CONCURRENTLY.*sku/)).toHaveLength(1);
    expect(db.executed(/UNIQUE/)).toHaveLength(1);
  });
});
