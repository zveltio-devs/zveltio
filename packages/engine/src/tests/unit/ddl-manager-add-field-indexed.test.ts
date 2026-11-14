/**
 * DDLManager.addField — indexed + unique constraints, and the PostgreSQL
 * extension a field type requires (ddl-manager.ts).
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

describe('DDLManager.addField — indexes', () => {
  it('adds concurrent index DDL when field.indexed is true', async () => {
    const db = new CannedDb();
    db.when(/SELECT EXISTS[\s\S]*pg_tables/i, [{ exists: true }]);
    db.when(/select \* from "zvd_collections" where "name" = /, [
      {
        name: 'products',
        fields: JSON.stringify([
          { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        ]),
      },
    ]);
    // The key's usual name is free.
    db.when(/SELECT to_regclass\(quote_ident\(\$1\)\) AS r/, [{ r: null }]);
    await DDLManager.addField(asDb(db), 'products', {
      name: 'sku',
      type: 'text',
      required: true,
      unique: true,
      indexed: true,
    } as never);
    // Two now, deliberately: the bare `(sku)` and the tenant-first
    // `(tenant_id, sku, created_at DESC)`. The second is the one a tenant-scoped
    // read can actually use — measured at 12,5 ms against 0,065 ms across ten
    // tenants, because the bare index cannot satisfy `ORDER BY created_at` and
    // the planner walks that index instead, discarding what the policy excludes.
    // See `fieldTypeRegistry.getTenantIndexDDL`.
    expect(db.executed(/CREATE INDEX CONCURRENTLY.*sku/)).toHaveLength(2);
    expect(
      db.executed(/CREATE INDEX CONCURRENTLY.*tenant_id, "sku", created_at DESC/),
    ).toHaveLength(1);
    // The key: its index built CONCURRENTLY, then attached — never `ADD UNIQUE`,
    // which builds the index under the table's exclusive lock (DR-37).
    expect(db.executed(/CREATE UNIQUE INDEX CONCURRENTLY[\s\S]*\(tenant_id, "sku"\)/)).toHaveLength(
      1,
    );
    expect(
      db.executed(/ADD CONSTRAINT "zvd_products_tenant_id_sku_key" UNIQUE USING INDEX/),
    ).toHaveLength(1);
    expect(db.executed(/ADD UNIQUE/)).toHaveLength(0);
  });

  it("installs the extension a field's type requires before adding the column", async () => {
    const db = new CannedDb();
    db.when(/SELECT EXISTS[\s\S]*pg_tables/i, [{ exists: true }]);
    db.when(/select \* from "zvd_collections" where "name" = /, [
      { name: 'products', fields: JSON.stringify([{ name: 'title', type: 'text' }]) },
    ]);
    await DDLManager.addField(asDb(db), 'products', { name: 'embedding', type: 'vector' } as never);
    const all = db.executed(
      /CREATE EXTENSION IF NOT EXISTS "vector"|ADD COLUMN IF NOT EXISTS "embedding"/,
    );
    expect(all.map((q) => (/CREATE EXTENSION/.test(q.sql) ? 'extension' : 'column'))).toEqual([
      'extension',
      'column',
    ]);
  });
});
