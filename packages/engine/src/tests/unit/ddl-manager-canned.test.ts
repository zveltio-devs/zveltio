/**
 * DDLManager DDL-executing paths (lib/data/ddl-manager.ts) — over CannedDb.
 *
 * Complements ddl-manager-pure.test.ts (name derivation + cache): these tests
 * drive createCollection/dropCollection/addField/removeField/introspection
 * against the canned Kysely driver and assert the exact DDL statements and
 * metadata writes the manager emits. Postgres-behavior itself (does the DDL
 * run?) stays covered by the collections integration tests.
 */

import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { CollectionSchema, DDLManager, fieldTypeRegistry } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

// The registry is populated at engine boot; mirror that here (register() is a
// Map.set, so this is overwrite-idempotent and safe for the shared singleton).
registerCoreFieldTypes(fieldTypeRegistry);

function setup(existingTables: string[] = []): CannedDb {
  const db = new CannedDb();
  db.when(/SELECT EXISTS[\s\S]*pg_tables/i, (q) => [
    { exists: existingTables.includes(String(q.parameters[0])) },
  ]);
  return db;
}

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

beforeEach(() => {
  DDLManager.invalidateCache();
});

const TEXT_FIELD = { name: 'title', type: 'text', required: true, unique: false, indexed: false };
const NUM_FIELD = { name: 'price', type: 'number', required: false, unique: false, indexed: true };

describe('CollectionSchema', () => {
  it('normalizes snake_case aliases to camelCase', () => {
    const parsed = CollectionSchema.parse({
      name: 'orders',
      display_name: 'Orders',
      singular_name: 'Order',
      is_system: true,
      fields: [TEXT_FIELD],
    });
    expect(parsed.displayName).toBe('Orders');
    expect(parsed.singularName).toBe('Order');
    expect(parsed.isSystem).toBe(true);
  });

  it('rejects invalid collection and field names', () => {
    expect(() => CollectionSchema.parse({ name: 'Bad-Name', fields: [TEXT_FIELD] })).toThrow();
    expect(() =>
      CollectionSchema.parse({ name: 'ok', fields: [{ name: '1bad', type: 'text' }] }),
    ).toThrow();
    expect(() => CollectionSchema.parse({ name: 'ok', fields: [] })).toThrow();
  });
});

describe('createCollection', () => {
  it('rejects disallowed PostgreSQL extensions', async () => {
    const db = setup();
    await expect(
      DDLManager.createCollection(asDb(db), {
        name: 'evil',
        fields: [{ name: 'vec', type: 'vector', options: { dimensions: 3 } }],
      } as never),
    ).rejects.toThrow('not in the allowed extensions whitelist');
  });

  it('creates the table with system columns, indexes, FTS and triggers', async () => {
    const db = setup();
    await DDLManager.createCollection(asDb(db), {
      name: 'articles',
      fields: [TEXT_FIELD, NUM_FIELD],
    } as never);

    const create = db.executed(/CREATE TABLE zvd_articles/)[0]!;
    expect(create.sql).toContain('id UUID PRIMARY KEY DEFAULT gen_random_uuid()');
    expect(create.sql).toContain('tenant_id UUID NOT NULL DEFAULT COALESCE');
    expect(create.sql).toContain('"title"');
    expect(create.sql).toContain('"price"');

    // standard + field indexes are CONCURRENTLY
    expect(
      db.executed(/CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zvd_articles_created_at/),
    ).toHaveLength(1);
    expect(
      db.executed(/CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zvd_articles_status/),
    ).toHaveLength(1);
    expect(db.executed(/CREATE INDEX CONCURRENTLY[\s\S]*"price"/)).toHaveLength(1);

    // FTS: vector column + GIN, and (because there IS a text field) trgm + trigger
    expect(db.executed(/ADD COLUMN IF NOT EXISTS search_vector tsvector/)).toHaveLength(1);
    expect(db.executed(/USING GIN\(search_vector\)/)).toHaveLength(1);
    expect(db.executed(/ADD COLUMN IF NOT EXISTS search_text text/)).toHaveLength(1);
    expect(db.executed(/gin_trgm_ops/)).toHaveLength(1);
    expect(db.executed(/CREATE TRIGGER zvd_articles_search_update/)).toHaveLength(1);
    expect(db.executed(/CREATE TRIGGER update_zvd_articles_updated_at/)).toHaveLength(1);

    // metadata registered + has_trgm flagged
    expect(db.executed(/insert into "zvd_collections"/)).toHaveLength(1);
    const trgmUpdate = db.executed(/update "zvd_collections" set "has_trgm"/)[0]!;
    expect(trgmUpdate.parameters).toContain(true);
  });

  it('skips the trgm/trigger machinery when no text fields exist', async () => {
    const db = setup();
    await DDLManager.createCollection(asDb(db), {
      name: 'metrics',
      fields: [NUM_FIELD],
    } as never);

    expect(db.executed(/search_vector tsvector/)).toHaveLength(1); // vector col always added
    expect(db.executed(/gin_trgm_ops/)).toHaveLength(0);
    expect(db.executed(/search_trigger/)).toHaveLength(0);
    expect(db.executed(/update "zvd_collections" set "has_trgm"/)).toHaveLength(0);
  });

  it('rejects unknown field types, missing relation targets, and duplicates', async () => {
    const db = setup(['zvd_dup']);
    await expect(
      DDLManager.createCollection(asDb(db), {
        name: 'x',
        fields: [{ name: 'f', type: 'wibble' }],
      } as never),
    ).rejects.toThrow('Unknown field type');

    await expect(
      DDLManager.createCollection(asDb(db), {
        name: 'x',
        fields: [{ name: 'author', type: 'm2o' }],
      } as never),
    ).rejects.toThrow('requires options.related_collection');

    await expect(
      DDLManager.createCollection(asDb(db), { name: 'dup', fields: [TEXT_FIELD] } as never),
    ).rejects.toThrow('already exists');
  });

  it('adds FK column + registers the relation for m2o fields with an existing target', async () => {
    const db = setup(['zvd_authors']);
    await DDLManager.createCollection(asDb(db), {
      name: 'books',
      fields: [
        TEXT_FIELD,
        {
          name: 'author',
          type: 'm2o',
          options: { related_collection: 'authors', on_delete: 'cascade' },
        },
      ],
    } as never);

    const fk = db.executed(/ALTER TABLE "zvd_books" ADD COLUMN IF NOT EXISTS "author" UUID/)[0]!;
    expect(fk.sql).toContain('REFERENCES "zvd_authors"(id) ON DELETE CASCADE ON UPDATE CASCADE');
    expect(
      db.executed(/CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zvd_books_author/),
    ).toHaveLength(1);
    const rel = db.executed(/insert into "zvd_relations"/)[0]!;
    expect(rel.parameters).toContain('books_author');
    expect(rel.parameters).toContain('m2o');
  });

  it('skips the FK (with a warning) when the relation target table is missing', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = setup(); // no zvd_ghosts
      await DDLManager.createCollection(asDb(db), {
        name: 'posts',
        fields: [
          TEXT_FIELD,
          { name: 'ghost', type: 'm2o', options: { related_collection: 'ghosts' } },
        ],
      } as never);
      expect(db.executed(/ADD COLUMN IF NOT EXISTS "ghost"/)).toHaveLength(0);
      expect(db.executed(/insert into "zvd_relations"/)).toHaveLength(0);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("'ghosts'"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('creates a junction table + relation row for m2m fields', async () => {
    const db = setup(['zvd_tags']);
    await DDLManager.createCollection(asDb(db), {
      name: 'notes',
      fields: [TEXT_FIELD, { name: 'tags', type: 'm2m', options: { related_collection: 'tags' } }],
    } as never);

    const jnc = db.executed(/CREATE TABLE IF NOT EXISTS "zvd_jnc_notes_tags"/)[0]!;
    expect(jnc.sql).toContain('"notes_id" UUID REFERENCES "zvd_notes"(id) ON DELETE CASCADE');
    expect(jnc.sql).toContain('"tags_id" UUID REFERENCES "zvd_tags"(id) ON DELETE CASCADE');
    expect(db.executed(/idx_zvd_jnc_notes_tags_src/)).toHaveLength(1);
    expect(db.executed(/idx_zvd_jnc_notes_tags_tgt/)).toHaveLength(1);
    const rel = db.executed(/insert into "zvd_relations"/)[0]!;
    expect(rel.parameters).toContain('m2m');
    expect(rel.parameters).toContain('zvd_jnc_notes_tags');
  });
});

describe('relation helpers', () => {
  it('applyRelationFK emits ALTER + CONCURRENTLY index for valid payloads', async () => {
    const db = setup();
    await DDLManager.applyRelationFK(asDb(db), 'zvd_orders', 'customer_id', 'zvd_customers');
    expect(
      db.executed(/ALTER TABLE "zvd_orders" ADD COLUMN IF NOT EXISTS "customer_id" UUID/),
    ).toHaveLength(1);
    expect(
      db.executed(/CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_zvd_orders_customer_id/),
    ).toHaveLength(1);
  });

  it('applyRelationFK refuses unsafe ON DELETE/UPDATE actions', async () => {
    const db = setup();
    await expect(
      DDLManager.applyRelationFK(asDb(db), 'zvd_a', 'f', 'zvd_b', 'EXPLODE'),
    ).rejects.toThrow('Invalid on_delete/on_update');
    expect(db.log).toHaveLength(0);
  });

  it('dropJunctionTable validates the zvd_jnc_ naming contract', async () => {
    const db = setup();
    await expect(DDLManager.dropJunctionTable(asDb(db), 'users')).rejects.toThrow(
      'Invalid junction table name',
    );
    await DDLManager.dropJunctionTable(asDb(db), 'zvd_jnc_notes_tags');
    expect(db.executed(/DROP TABLE IF EXISTS "zvd_jnc_notes_tags" CASCADE/)).toHaveLength(1);
  });

  it('registerRelation swallows conflicts/errors with a warning', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = setup();
      db.fail(/insert into "zvd_relations"/, new Error('duplicate key'));
      await DDLManager.registerRelation(asDb(db), {
        name: 'a_b',
        type: 'm2o',
        source_collection: 'a',
        source_field: 'b',
        target_collection: 'c',
        target_field: 'id',
      });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('[registerRelation]'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('dropCollection', () => {
  it('throws for a missing collection', async () => {
    const db = setup();
    await expect(DDLManager.dropCollection(asDb(db), 'ghost')).rejects.toThrow('not found');
  });

  it('refuses to drop when FKs reference it, unless force', async () => {
    const db = setup(['zvd_authors']);
    db.when(/FOREIGN KEY/, [
      { table: 'zvd_books', constraint: 'fk_books_author', column: 'author' },
    ]);

    await expect(DDLManager.dropCollection(asDb(db), 'authors')).rejects.toThrow(
      'zvd_books.author (constraint fk_books_author)',
    );
    expect(db.executed(/DROP TABLE IF EXISTS zvd_authors/)).toHaveLength(0);

    await DDLManager.dropCollection(asDb(db), 'authors', { force: true });
    expect(db.executed(/DROP TABLE IF EXISTS zvd_authors CASCADE/)).toHaveLength(1);
  });

  it('drops m2m junction tables and cleans relation + collection metadata', async () => {
    const db = setup(['zvd_notes']);
    db.when(
      /select "source_collection", "target_collection", "junction_table" from "zvd_relations"/,
      [
        {
          source_collection: 'notes',
          target_collection: 'tags',
          junction_table: 'zvd_jnc_notes_tags',
        },
        { source_collection: 'labels', target_collection: 'notes', junction_table: null }, // legacy naming
      ],
    );

    await DDLManager.dropCollection(asDb(db), 'notes');

    expect(db.executed(/DROP TABLE IF EXISTS "zvd_jnc_notes_tags" CASCADE/)).toHaveLength(1);
    expect(db.executed(/DROP TABLE IF EXISTS "zvd_jnc_labels_notes" CASCADE/)).toHaveLength(1);
    expect(db.executed(/DROP TABLE IF EXISTS zvd_notes CASCADE/)).toHaveLength(1);
    expect(db.executed(/delete from "zvd_relations"/)).toHaveLength(1);
    const delMeta = db.executed(/delete from "zvd_collections"/)[0]!;
    expect(delMeta.parameters).toContain('notes');
  });
});

describe('addField / removeField', () => {
  it('addField emits column + index DDL and appends to stored metadata', async () => {
    const db = setup(['zvd_articles']);
    db.when(/select \* from "zvd_collections" where "name" = /, [
      { name: 'articles', fields: JSON.stringify([TEXT_FIELD]) },
    ]);

    await DDLManager.addField(asDb(db), 'articles', {
      name: 'subtitle',
      type: 'text',
      required: false,
      unique: false,
      indexed: true,
    } as never);

    expect(db.executed(/alter table "zvd_articles" add column if not exists/i)).toHaveLength(1);
    expect(db.executed(/CREATE INDEX CONCURRENTLY[\s\S]*subtitle/)).toHaveLength(1);
    const metaUpdate = db.executed(/update "zvd_collections" set/)[0]!;
    expect(String(metaUpdate.parameters[0])).toContain('subtitle');
  });

  it('addField refuses unknown types and missing collections', async () => {
    const db = setup();
    await expect(
      DDLManager.addField(asDb(db), 'articles', { name: 'f', type: 'wibble' } as never),
    ).rejects.toThrow('Unknown field type');
    await expect(
      DDLManager.addField(asDb(db), 'ghost', { name: 'f', type: 'text' } as never),
    ).rejects.toThrow('not found');
  });

  it('removeField validates the name, drops the column and rewrites metadata', async () => {
    const db = setup(['zvd_articles']);
    db.when(/select \* from "zvd_collections" where "name" = /, [
      { name: 'articles', fields: JSON.stringify([TEXT_FIELD, { name: 'old', type: 'text' }]) },
    ]);

    await expect(DDLManager.removeField(asDb(db), 'articles', 'BAD name')).rejects.toThrow(
      'Invalid field name',
    );

    await DDLManager.removeField(asDb(db), 'articles', 'old');
    expect(db.executed(/drop column if exists "old"/i)).toHaveLength(1);
    const metaUpdate = db.executed(/update "zvd_collections" set/)[0]!;
    expect(String(metaUpdate.parameters[0])).not.toContain('"old"');
  });
});

describe('previewCollection (pure)', () => {
  it('renders the CREATE TABLE with FK columns, indexes, uniques and relation inserts', async () => {
    const { sql: stmts } = await DDLManager.previewCollection({
      name: 'books',
      fields: [
        { ...TEXT_FIELD, unique: true },
        NUM_FIELD,
        { name: 'author', type: 'm2o', options: { related_collection: 'authors' } },
      ],
    } as never);

    const all = stmts.join('\n');
    expect(all).toContain('CREATE TABLE IF NOT EXISTS zvd_books');
    expect(all).toContain('"author" UUID REFERENCES "zvd_authors"(id) ON DELETE SET NULL');
    expect(all).toContain('ADD CONSTRAINT uq_zvd_books_title UNIQUE ("title")');
    expect(all).toContain('idx_zvd_books_price');
    expect(all).toContain('idx_zvd_books_author');
    expect(all).toContain(`VALUES ('books_author', 'm2o', 'books', 'author', 'authors', 'id');`);
    expect(all).toContain('update_zvd_books_updated_at');
  });

  it('rejects invalid collection names', async () => {
    await expect(
      DDLManager.previewCollection({ name: 'Bad Name', fields: [TEXT_FIELD] } as never),
    ).rejects.toThrow('Invalid collection name');
  });
});

describe('introspection', () => {
  it('maps pg column types to field types, FKs to m2o, and filters system columns', async () => {
    const db = setup();
    db.when(/FROM information_schema\.columns/i, [
      { column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO' },
      { column_name: 'tenant_id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO' },
      { column_name: 'title', data_type: 'text', udt_name: 'text', is_nullable: 'NO' },
      { column_name: 'count', data_type: 'integer', udt_name: 'int4', is_nullable: 'YES' },
      { column_name: 'price', data_type: 'numeric', udt_name: 'numeric', is_nullable: 'YES' },
      { column_name: 'active', data_type: 'boolean', udt_name: 'bool', is_nullable: 'YES' },
      { column_name: 'meta', data_type: 'jsonb', udt_name: 'jsonb', is_nullable: 'YES' },
      { column_name: 'labels', data_type: 'ARRAY', udt_name: '_text', is_nullable: 'YES' },
      { column_name: 'due_on', data_type: 'date', udt_name: 'date', is_nullable: 'YES' },
      {
        column_name: 'seen_at',
        data_type: 'timestamptz',
        udt_name: 'timestamptz',
        is_nullable: 'YES',
      },
      { column_name: 'author', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'YES' },
    ]);
    db.when(/FOREIGN KEY/, [{ column_name: 'author', foreign_table_name: 'zvd_authors' }]);

    const fields = await DDLManager.introspectTable(asDb(db), 'books');
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]));

    expect(byName.id).toBeUndefined(); // system col filtered
    expect(byName.tenant_id).toBeUndefined();
    expect(byName.title).toMatchObject({ type: 'text', required: true });
    expect(byName.count!.type).toBe('integer');
    expect(byName.price!.type).toBe('number');
    expect(byName.active!.type).toBe('boolean');
    expect(byName.meta!.type).toBe('json');
    expect(byName.labels!.type).toBe('tags');
    expect(byName.due_on!.type).toBe('date');
    expect(byName.seen_at!.type).toBe('datetime');
    expect(byName.author).toMatchObject({
      type: 'm2o',
      options: { related_collection: 'authors' },
    });
  });

  it('syncFieldsFromDB backfills empty metadata from introspection', async () => {
    const db = setup(['zvd_legacy']);
    db.when(/select \* from "zvd_collections" where "name" = /, [{ name: 'legacy', fields: '[]' }]);
    db.when(/FROM information_schema\.columns/i, [
      { column_name: 'title', data_type: 'text', udt_name: 'text', is_nullable: 'YES' },
    ]);

    expect(await DDLManager.syncFieldsFromDB(asDb(db), 'legacy')).toBe(1);
    const update = db.executed(/update "zvd_collections" set "fields"/)[0]!;
    expect(String(update.parameters[0])).toContain('title');
  });

  it('syncFieldsFromDB is a no-op when metadata already has fields or the collection is unknown', async () => {
    const db = setup(['zvd_full']);
    db.when(/select \* from "zvd_collections" where "name" = /, (q) =>
      q.parameters[0] === 'full' ? [{ name: 'full', fields: JSON.stringify([TEXT_FIELD]) }] : [],
    );
    expect(await DDLManager.syncFieldsFromDB(asDb(db), 'full')).toBe(0);
    expect(await DDLManager.syncFieldsFromDB(asDb(db), 'unknown')).toBe(0);
  });
});

describe('metadata cache', () => {
  it('getCollection caches per-name until invalidated', async () => {
    const db = setup();
    db.when(/select \* from "zvd_collections" where "name" = /, [
      { name: 'solo', fields: JSON.stringify([TEXT_FIELD]) },
    ]);

    const first = await DDLManager.getCollection(asDb(db), 'solo');
    expect(first?.name).toBe('solo');
    expect(first?.fields).toEqual([TEXT_FIELD]);

    await DDLManager.getCollection(asDb(db), 'solo');
    expect(db.executed(/where "name" = /)).toHaveLength(1);

    DDLManager.invalidateCache('solo');
    await DDLManager.getCollection(asDb(db), 'solo');
    expect(db.executed(/where "name" = /)).toHaveLength(2);
  });

  it('getCollection returns null for unknown collections', async () => {
    const db = setup();
    expect(await DDLManager.getCollection(asDb(db), 'ghost')).toBeNull();
  });

  it('registerMetadata upserts collection rows with defaults', async () => {
    const db = setup();
    await DDLManager.registerMetadata(asDb(db), {
      name: 'widgets',
      fields: [TEXT_FIELD],
      displayName: 'Widgets',
      icon: 'Box',
      routeGroup: 'admin',
    } as never);
    const insert = db.executed(/insert into "zvd_collections"/)[0]!;
    expect(insert.parameters).toContain('Widgets');
    expect(insert.parameters).toContain('admin');
    expect(insert.sql).toContain('on conflict');
  });

  it('getCollections caches the normalized list until invalidated', async () => {
    const db = setup();
    db.when(/select \* from "zvd_collections" order by/, [
      { name: 'a', fields: JSON.stringify([TEXT_FIELD]) },
      { name: 'b', fields: null },
    ]);

    const first = await DDLManager.getCollections(asDb(db));
    expect(first[0]!.fields).toEqual([TEXT_FIELD]); // JSON string normalized
    expect(first[1]!.fields).toEqual([]); // null normalized

    await DDLManager.getCollections(asDb(db));
    expect(db.executed(/order by/)).toHaveLength(1); // second call served from cache

    DDLManager.invalidateCache();
    await DDLManager.getCollections(asDb(db));
    expect(db.executed(/order by/)).toHaveLength(2);
  });

  it('updateCollectionMetadata writes only the provided keys and invalidates', async () => {
    const db = setup();
    await DDLManager.updateCollectionMetadata(asDb(db), 'articles', {
      displayName: 'Articles!',
    } as never);
    const q = db.executed(/update "zvd_collections" set/)[0]!;
    expect(q.parameters).toContain('Articles!');
    expect(q.parameters).toContain('articles');
    expect(q.sql).not.toContain('"icon"');
  });
});
