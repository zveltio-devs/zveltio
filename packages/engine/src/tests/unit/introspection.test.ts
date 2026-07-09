/**
 * BYOD introspection (lib/introspection.ts) — over CannedDb.
 *
 * introspectSchema scans information_schema, maps pg types → Zveltio field
 * types, skips platform/excluded tables, and upserts each discovered table as
 * an UNMANAGED collection (is_managed=false). These tests pin the filtering,
 * the type/required/label derivation, and the dry-run vs insert vs update
 * branches.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { introspectSchema } from '../../lib/introspection.js';
import { CannedDb } from './fixtures/canned-db.js';

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

/** Register the table list + per-table column sets for a scan. */
function withSchema(db: CannedDb, tables: Record<string, unknown[]>) {
  db.when(
    /SELECT DISTINCT table_name/i,
    Object.keys(tables).map((t) => ({ table_name: t })),
  );
  db.when(/SELECT column_name, data_type, is_nullable, column_default/i, (q) => {
    const table = q.parameters[1]; // $1 = schema, $2 = table_name
    return (tables[table as string] ?? []) as unknown[];
  });
}

const COL = (over: Record<string, unknown> = {}) => ({
  column_name: 'title',
  data_type: 'text',
  is_nullable: 'YES',
  column_default: null,
  ...over,
});

describe('introspectSchema — filtering', () => {
  it('skips platform tables and excluded patterns', async () => {
    const db = new CannedDb();
    withSchema(db, {
      zv_settings: [COL()],
      zvd_orders: [COL()],
      _zv_ghost_x: [COL()],
      pg_stat: [COL()],
      temp_import: [COL()],
      customers: [COL()],
    });

    const result = await introspectSchema(asDb(db), 'public', ['temp_'], true);
    expect(result.map((r) => r.tableName)).toEqual(['customers']);
  });

  it('skips tables that have no columns', async () => {
    const db = new CannedDb();
    withSchema(db, { empty_table: [], real_table: [COL()] });
    const result = await introspectSchema(asDb(db), 'public', [], true);
    expect(result.map((r) => r.tableName)).toEqual(['real_table']);
  });
});

describe('introspectSchema — field derivation (dry run)', () => {
  it('maps pg types, derives required from NOT NULL + no default, and title-cases labels', async () => {
    const db = new CannedDb();
    let capturedFields: unknown[] = [];
    // intercept the insert to inspect the serialized fields
    db.when(/insert into "zvd_collections"/i, (q) => {
      const f = q.parameters.find((p) => typeof p === 'string' && p.startsWith('['));
      if (f) capturedFields = JSON.parse(f as string);
      return [];
    });
    db.when(/select "id" from "zvd_collections"/i, []); // not existing → insert path
    withSchema(db, {
      people: [
        COL({ column_name: 'full_name', data_type: 'character varying', is_nullable: 'NO' }),
        COL({ column_name: 'age', data_type: 'integer' }),
        COL({ column_name: 'active', data_type: 'boolean' }),
        COL({ column_name: 'created_on', data_type: 'timestamp with time zone' }),
        COL({ column_name: 'meta', data_type: 'jsonb' }),
        COL({ column_name: 'weird', data_type: 'macaddr' }), // unknown → text
        COL({
          column_name: 'has_default',
          data_type: 'integer',
          is_nullable: 'NO',
          column_default: '0',
        }),
      ],
    });

    await introspectSchema(asDb(db), 'public', [], false);
    const byName = Object.fromEntries(
      (
        capturedFields as Array<{ name: string; type: string; required: boolean; label: string }>
      ).map((f) => [f.name, f]),
    );
    expect(byName.full_name.type).toBe('text');
    expect(byName.full_name.required).toBe(true); // NOT NULL + no default
    expect(byName.full_name.label).toBe('Full Name');
    expect(byName.age.type).toBe('number');
    expect(byName.active.type).toBe('boolean');
    expect(byName.created_on.type).toBe('datetime');
    expect(byName.meta.type).toBe('json');
    expect(byName.weird.type).toBe('text'); // unknown pg type falls back to text
    expect(byName.has_default.required).toBe(false); // has a default → not required
  });
});

describe('introspectSchema — write branches', () => {
  it('inserts a new unmanaged collection with source_type=table', async () => {
    const db = new CannedDb();
    db.when(/select "id" from "zvd_collections"/i, []); // miss → insert
    withSchema(db, { invoices: [COL({ column_name: 'number' })] });

    const result = await introspectSchema(asDb(db), 'public', [], false);
    expect(result).toEqual([
      { tableName: 'invoices', collectionName: 'invoices', fieldsCount: 1, isNew: true },
    ]);
    const insert = db.executed(/insert into "zvd_collections"/i)[0]!;
    expect(insert.parameters).toContain('invoices');
    expect(insert.parameters).toContain(false); // is_managed
    expect(insert.parameters).toContain('table'); // source_type
    expect(insert.parameters).toContain('Invoices'); // display_name title-cased
  });

  it('updates an existing collection without touching is_managed', async () => {
    const db = new CannedDb();
    db.when(/select "id" from "zvd_collections"/i, [{ id: 'existing-1' }]); // hit → update
    withSchema(db, { legacy: [COL()] });

    const result = await introspectSchema(asDb(db), 'public', [], false);
    expect(result[0]!.isNew).toBe(false);
    const update = db.executed(/update "zvd_collections" set/i)[0]!;
    expect(update.sql).toContain('"fields"');
    expect(update.sql).not.toContain('is_managed'); // never rewritten on update
    expect(db.executed(/insert into "zvd_collections"/i)).toHaveLength(0);
  });

  it('honors a non-default schema name in the queries', async () => {
    const db = new CannedDb();
    withSchema(db, { t: [COL()] });
    await introspectSchema(asDb(db), 'tenant_acme', [], true);
    expect(db.executed(/SELECT DISTINCT table_name/i)[0]!.parameters).toContain('tenant_acme');
  });
});
