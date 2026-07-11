/**
 * DDLManager.createCollection — virtual field column skip (ddl-manager.ts).
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

describe('DDLManager.createCollection — virtual fields', () => {
  it('omits virtual columns from CREATE TABLE but keeps them in metadata', async () => {
    const db = new CannedDb();
    db.when(/SELECT EXISTS[\s\S]*pg_tables/i, [{ exists: false }]);

    await DDLManager.createCollection(asDb(db), {
      name: 'mixed',
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'rollup', type: 'computed', required: false, unique: false, indexed: false },
      ],
    } as never);

    const create = db.executed(/CREATE TABLE zvd_mixed/)[0]!;
    expect(create.sql).toContain('"title"');
    expect(create.sql).not.toContain('"rollup"');

    const meta = db.executed(/insert into "zvd_collections"/)[0]!;
    expect(String(meta.parameters)).toContain('rollup');
  });
});
