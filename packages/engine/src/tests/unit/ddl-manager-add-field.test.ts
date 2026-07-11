/**
 * DDLManager.addField (lib/data/ddl-manager.ts) — column + index DDL paths.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { DDLManager, fieldTypeRegistry } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

registerCoreFieldTypes(fieldTypeRegistry);

function setup(existing: string[] = ['zvd_articles']): CannedDb {
  const db = new CannedDb();
  db.when(/SELECT EXISTS[\s\S]*pg_tables/i, (q) => [
    { exists: existing.includes(String(q.parameters[0])) },
  ]);
  db.when(/select \* from "zvd_collections" where "name" = /, [
    {
      name: 'articles',
      fields: JSON.stringify([
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
      ]),
    },
  ]);
  return db;
}

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

beforeEach(() => {
  DDLManager.invalidateCache();
});

describe('DDLManager.addField', () => {
  it('adds a column, concurrent index, and appends metadata', async () => {
    const db = setup();
    await DDLManager.addField(asDb(db), 'articles', {
      name: 'sku',
      type: 'text',
      required: false,
      unique: false,
      indexed: true,
    } as never);
    expect(db.executed(/ADD COLUMN IF NOT EXISTS "sku"/)).toHaveLength(1);
    expect(db.executed(/CREATE INDEX CONCURRENTLY.*sku/)).toHaveLength(1);
    expect(db.executed(/update "zvd_collections" set/)).toHaveLength(1);
  });

  it('rejects unknown field types before touching the database', async () => {
    const db = setup();
    await expect(
      DDLManager.addField(asDb(db), 'articles', {
        name: 'weird',
        type: 'not_a_type',
        required: false,
        unique: false,
        indexed: false,
      } as never),
    ).rejects.toThrow('Unknown field type');
    expect(db.executed(/ALTER TABLE/)).toHaveLength(0);
  });

  it('throws when the collection table is missing', async () => {
    const db = setup([]);
    await expect(
      DDLManager.addField(asDb(db), 'articles', {
        name: 'x',
        type: 'text',
        required: false,
        unique: false,
        indexed: false,
      } as never),
    ).rejects.toThrow("Collection 'articles' not found");
  });
});
