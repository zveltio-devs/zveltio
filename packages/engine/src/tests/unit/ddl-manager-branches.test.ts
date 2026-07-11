/**
 * DDLManager branch coverage (lib/data/ddl-manager.ts) — relation skip paths,
 * pgvector extension, multi-text FTS weights, getTableDependents, tableExists.
 */

import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
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

describe('createCollection — relation + extension branches', () => {
  it('creates postgis extension for location fields', async () => {
    const db = setup();
    await DDLManager.createCollection(asDb(db), {
      name: 'places',
      fields: [TEXT, { name: 'coords', type: 'location', required: false }],
    } as never);
    expect(db.executed(/CREATE EXTENSION IF NOT EXISTS "postgis"/)).toHaveLength(1);
    expect(db.executed(/CREATE TABLE zvd_places/)).toHaveLength(1);
  });

  it('uses C/D FTS weights when three or more text fields exist', async () => {
    const db = setup();
    await DDLManager.createCollection(asDb(db), {
      name: 'articles',
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'subtitle', type: 'text', required: false, unique: false, indexed: false },
        { name: 'body', type: 'richtext', required: false, unique: false, indexed: false },
        { name: 'tags', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    const trigger = db.executed(/CREATE OR REPLACE FUNCTION zvd_articles_search_trigger/)[0]!;
    expect(trigger.sql).toContain("'C'");
    expect(trigger.sql).toContain("'D'");
    expect(db.executed(/update "zvd_collections" set "has_trgm"/)).toHaveLength(1);
  });

  it('skips m2o when target collection name is unsafe', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = setup(['zvd_authors']);
      await DDLManager.createCollection(asDb(db), {
        name: 'books',
        fields: [TEXT, { name: 'bad', type: 'm2o', options: { related_collection: 'Bad-Name' } }],
      } as never);
      expect(db.executed(/ADD COLUMN IF NOT EXISTS "bad"/)).toHaveLength(0);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('Invalid target name'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('skips m2m when junction target is missing', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = setup();
      await DDLManager.createCollection(asDb(db), {
        name: 'notes',
        fields: [TEXT, { name: 'tags', type: 'm2m', options: { related_collection: 'tags' } }],
      } as never);
      expect(db.executed(/zvd_jnc_notes_tags/)).toHaveLength(0);
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("m2m target 'tags' not found")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('skips m2m when target collection name is unsafe', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = setup(['zvd_tags']);
      await DDLManager.createCollection(asDb(db), {
        name: 'notes',
        fields: [TEXT, { name: 'tags', type: 'm2m', options: { related_collection: 'Bad-Name' } }],
      } as never);
      expect(db.executed(/zvd_jnc_notes/)).toHaveLength(0);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('Invalid m2m target'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('adds reference-type FK columns like m2o', async () => {
    const db = setup(['zvd_users']);
    await DDLManager.createCollection(asDb(db), {
      name: 'tasks',
      fields: [
        TEXT,
        { name: 'assignee', type: 'reference', options: { related_collection: 'users' } },
      ],
    } as never);
    expect(db.executed(/ADD COLUMN IF NOT EXISTS "assignee" UUID/)).toHaveLength(1);
  });
});

describe('introspection helpers', () => {
  it('tableExists reflects pg_tables probe', async () => {
    const db = setup(['zvd_known']);
    expect(await DDLManager.tableExists(asDb(db), 'known')).toBe(true);
    expect(await DDLManager.tableExists(asDb(db), 'ghost')).toBe(false);
  });

  it('getTableDependents returns FK rows referencing the collection', async () => {
    const db = setup();
    db.when(/information_schema\.table_constraints/i, [
      { table: 'zvd_books', constraint: 'fk_books_author', column: 'author' },
    ]);
    const deps = await DDLManager.getTableDependents(asDb(db), 'authors');
    expect(deps).toHaveLength(1);
    expect(deps[0]!.table).toBe('zvd_books');
  });
});

describe('dropCollection — failure tolerance', () => {
  it('warns when m2m relation lookup fails but still drops the table', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = setup(['zvd_items']);
      db.fail(
        /select "source_collection", "target_collection", "junction_table" from "zvd_relations"/i,
        new Error('timeout'),
      );
      await DDLManager.dropCollection(asDb(db), 'items');
      expect(db.executed(/DROP TABLE IF EXISTS zvd_items CASCADE/)).toHaveLength(1);
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('m2m relations lookup failed')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('addField metadata', () => {
  it('does not duplicate a field already present in collection metadata', async () => {
    const db = setup(['zvd_articles']);
    db.when(/select \* from "zvd_collections" where "name" = /, [
      {
        name: 'articles',
        fields: JSON.stringify([TEXT, { name: 'subtitle', type: 'text' }]),
      },
    ]);
    await DDLManager.addField(asDb(db), 'articles', {
      name: 'subtitle',
      type: 'text',
      required: false,
      unique: false,
      indexed: false,
    } as never);
    expect(db.executed(/update "zvd_collections" set/)).toHaveLength(0);
  });
});

describe('updateCollectionMetadata — all keys', () => {
  it('writes icon, description, and fields when provided', async () => {
    const db = setup();
    await DDLManager.updateCollectionMetadata(asDb(db), 'widgets', {
      icon: 'Star',
      description: 'All widgets',
      fields: [TEXT],
    } as never);
    const q = db.executed(/update "zvd_collections" set/)[0]!;
    expect(q.sql).toContain('"fields"');
    expect(q.parameters).toContain('Star');
    expect(q.parameters).toContain('All widgets');
  });
});
