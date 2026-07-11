/**
 * DDLManager.addField — field types with no physical column DDL (e.g. json).
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

describe('DDLManager.addField — virtual field types', () => {
  it('skips ALTER TABLE when the field type has no column DDL', async () => {
    const db = new CannedDb();
    db.when(/SELECT EXISTS[\s\S]*pg_tables/i, [{ exists: true }]);
    db.when(/select \* from "zvd_collections" where "name" = /, [
      {
        name: 'articles',
        fields: JSON.stringify([
          { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        ]),
      },
    ]);
    await DDLManager.addField(asDb(db), 'articles', {
      name: 'total',
      type: 'computed',
      required: false,
      unique: false,
      indexed: false,
    } as never);
    expect(db.executed(/ALTER TABLE/)).toHaveLength(0);
    expect(db.executed(/update "zvd_collections" set/)).toHaveLength(1);
  });
});
