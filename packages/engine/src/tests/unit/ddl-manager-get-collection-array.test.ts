/**
 * DDLManager.getCollection/getCollections — pre-parsed fields arrays (ddl-manager.ts).
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

describe('DDLManager metadata — array fields', () => {
  it('getCollection accepts fields already stored as an array', async () => {
    const db = new CannedDb();
    db.when(/select \* from "zvd_collections" where "name" = /i, [
      {
        name: 'widgets',
        fields: [{ name: 'title', type: 'text' }],
      },
    ]);
    const row = await DDLManager.getCollection(asDb(db), 'widgets');
    expect(row?.fields?.[0]?.name).toBe('title');
  });

  it('getCollections normalizes array fields without JSON.parse', async () => {
    const db = new CannedDb();
    db.when(/from "zvd_collections"/i, [
      { name: 'widgets', fields: [{ name: 'sku', type: 'text' }], sort: 1 },
    ]);
    const rows = await DDLManager.getCollections(asDb(db));
    expect(rows[0]?.fields?.[0]?.name).toBe('sku');
  });
});
