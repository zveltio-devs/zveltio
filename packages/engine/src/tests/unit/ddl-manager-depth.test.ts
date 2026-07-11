/**
 * DDLManager depth coverage (lib/data/ddl-manager.ts) — drop guards, removeField,
 * syncFieldsFromDB, preview indexes, two-text FTS weight B.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { DDLManager, fieldTypeRegistry } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

registerCoreFieldTypes(fieldTypeRegistry);

const TEXT = { name: 'title', type: 'text', required: true, unique: false, indexed: false };

function setup(existing: string[] = []): CannedDb {
  const db = new CannedDb();
  db.when(/SELECT EXISTS[\s\S]*pg_tables/i, (q) => [
    { exists: existing.includes(String(q.parameters[0])) },
  ]);
  return db;
}

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

beforeEach(() => {
  DDLManager.invalidateCache();
});

describe('dropCollection — dependents + force', () => {
  it('rejects drop when FK dependents exist and force is false', async () => {
    const db = setup(['zvd_authors']);
    db.when(/information_schema\.table_constraints/i, [
      { table: 'zvd_books', constraint: 'fk_books_author', column: 'author_id' },
    ]);
    await expect(DDLManager.dropCollection(asDb(db), 'authors')).rejects.toThrow(
      'Cannot drop collection',
    );
    expect(db.executed(/DROP TABLE IF EXISTS zvd_authors/)).toHaveLength(0);
  });

  it('drops with CASCADE when force=true despite dependents', async () => {
    const db = setup(['zvd_authors']);
    db.when(/information_schema\.table_constraints/i, [
      { table: 'zvd_books', constraint: 'fk_books_author', column: 'author_id' },
    ]);
    db.when(
      /select "source_collection", "target_collection", "junction_table" from "zvd_relations"/i,
      [],
    );
    await DDLManager.dropCollection(asDb(db), 'authors', { force: true });
    expect(db.executed(/DROP TABLE IF EXISTS zvd_authors CASCADE/)).toHaveLength(1);
    expect(db.executed(/delete from "zvd_collections"/)).toHaveLength(1);
  });
});

describe('removeField', () => {
  it('drops the column and prunes collection metadata', async () => {
    const db = setup(['zvd_posts']);
    db.when(/select \* from "zvd_collections" where "name" = /, [
      {
        name: 'posts',
        fields: JSON.stringify([
          TEXT,
          { name: 'subtitle', type: 'text', required: false, unique: false, indexed: false },
        ]),
      },
    ]);
    await DDLManager.removeField(asDb(db), 'posts', 'subtitle');
    expect(db.executed(/DROP COLUMN IF EXISTS "subtitle"/)).toHaveLength(1);
    const upd = db.executed(/update "zvd_collections" set/)[0]!;
    expect(upd.parameters.some((p) => String(p).includes('subtitle'))).toBe(false);
  });

  it('rejects unsafe field names', async () => {
    const db = setup(['zvd_posts']);
    await expect(DDLManager.removeField(asDb(db), 'posts', 'Bad-Field')).rejects.toThrow(
      'Invalid field name',
    );
  });
});

describe('syncFieldsFromDB', () => {
  it('introspects an empty-metadata collection and writes fields', async () => {
    const db = setup(['zvd_legacy']);
    db.when(/select \* from "zvd_collections" where "name" = /, [
      { name: 'legacy', fields: JSON.stringify([]) },
    ]);
    db.when(/FROM information_schema\.columns/i, [
      { column_name: 'title', data_type: 'text', udt_name: 'text', is_nullable: 'NO' },
    ]);
    db.when(/FROM information_schema\.table_constraints tc/i, []);
    const n = await DDLManager.syncFieldsFromDB(asDb(db), 'legacy');
    expect(n).toBe(1);
    expect(db.executed(/update "zvd_collections" set "fields"/)).toHaveLength(1);
  });

  it('returns 0 when metadata already has fields', async () => {
    const db = setup(['zvd_legacy']);
    db.when(/select \* from "zvd_collections" where "name" = /, [
      { name: 'legacy', fields: JSON.stringify([TEXT]) },
    ]);
    expect(await DDLManager.syncFieldsFromDB(asDb(db), 'legacy')).toBe(0);
  });
});

describe('createCollection — FTS weight B', () => {
  it('uses FTS weight B when exactly two text fields exist', async () => {
    const db = setup();
    await DDLManager.createCollection(asDb(db), {
      name: 'pairs',
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'summary', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    const trigger = db.executed(/CREATE OR REPLACE FUNCTION zvd_pairs_search_trigger/)[0]!;
    expect(trigger.sql).toContain("'B'");
    expect(trigger.sql).not.toContain("'C'");
  });
});

describe('previewCollection — index preview', () => {
  it('includes CREATE INDEX and UNIQUE constraint lines', async () => {
    const preview = await DDLManager.previewCollection({
      name: 'preview_me',
      fields: [{ name: 'slug', type: 'text', required: true, unique: true, indexed: true }],
    } as never);
    expect(preview.sql.some((s) => /CREATE INDEX/i.test(s))).toBe(true);
    expect(preview.sql.some((s) => /UNIQUE/i.test(s))).toBe(true);
  });
});
