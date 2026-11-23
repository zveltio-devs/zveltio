/**
 * DDLManager.addField — metadata dedup when the field already exists.
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

describe('DDLManager.addField — metadata', () => {
  it('does not duplicate an existing field name in collection metadata', async () => {
    const db = new CannedDb();
    db.when(/SELECT EXISTS[\s\S]*pg_tables/i, [{ exists: true }]);
    db.when(/select \* from "zvd_collections" where "name" = /, [
      {
        name: 'articles',
        fields: JSON.stringify([
          { name: 'title', type: 'text', required: true, unique: false, indexed: false },
          { name: 'sku', type: 'text', required: false, unique: false, indexed: false },
        ]),
      },
    ]);
    await DDLManager.addField(asDb(db), 'articles', {
      name: 'sku',
      type: 'text',
      required: false,
      unique: false,
      indexed: false,
    } as never);
    expect(db.executed(/update "zvd_collections" set/).length).toBe(0);
  });

  it('refuses the name recorded with another config, before any DDL (A15)', async () => {
    const db = new CannedDb();
    db.when(/SELECT EXISTS[\s\S]*pg_tables/i, [{ exists: true }]);
    db.when(/select \* from "zvd_collections" where "name" = /, [
      { name: 'articles', fields: JSON.stringify([{ name: 'sku', type: 'text' }]) },
    ]);
    const err = await DDLManager.addField(asDb(db), 'articles', {
      name: 'sku',
      type: 'integer',
    } as never).catch((e: Error & { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('DUPLICATE');
    expect((err as Error).message).toContain('already exists');
    expect(db.executed(/ALTER TABLE/i).length).toBe(0);
    expect(db.executed(/update "zvd_collections" set/).length).toBe(0);
  });
});
