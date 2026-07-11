/**
 * DDLManager.createCollection — FTS/trgm path for text fields (ddl-manager.ts).
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

describe('DDLManager.createCollection — FTS fields', () => {
  it('creates search_vector, search_text, trgm index, and sets has_trgm', async () => {
    const db = new CannedDb();
    db.when(/SELECT EXISTS[\s\S]*pg_tables/i, [{ exists: false }]);

    await DDLManager.createCollection(asDb(db), {
      name: 'articles',
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'summary', type: 'richtext', required: false, unique: false, indexed: false },
      ],
    } as never);

    expect(db.executed(/search_vector tsvector/)).toHaveLength(1);
    expect(db.executed(/search_text text/)).toHaveLength(1);
    expect(db.executed(/gin_trgm_ops/)).toHaveLength(1);
    expect(db.executed(/update "zvd_collections"/i)).toHaveLength(1);
    expect(db.executed(/"has_trgm"/)).toHaveLength(1);
    expect(db.executed(/_search_trigger/).length).toBeGreaterThanOrEqual(1);
  });
});
