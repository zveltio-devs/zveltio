/**
 * GhostDDL takes typed operations and builds their SQL itself (ghost-ddl.ts).
 *
 * It took raw `ALTER TABLE` fragments checked by a regex whose type part
 * admitted commas and keywords, so `ADD COLUMN x text, DROP COLUMN tenant_id`
 * and `ADD COLUMN x text, ADD CONSTRAINT evil CHECK (true)` passed it. The typed
 * API has no way to say either: a string, an unknown kind, a system column or a
 * name that is not an identifier is refused before anything is created.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { fieldTypeRegistry } from '../../lib/data/field-type-registry.js';
import * as ghostModule from '../../lib/data/ghost-ddl.js';
import { GhostDDL, type GhostOperation } from '../../lib/data/ghost-ddl.js';
import { CannedDb } from './fixtures/canned-db.js';

registerCoreFieldTypes(fieldTypeRegistry);

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

describe('GhostDDL operations', () => {
  it('builds each operation on the ghost, from the registry, with quoted names', async () => {
    const db = new CannedDb();
    await GhostDDL.createGhost(asDb(db), 'zvd_items', [
      {
        kind: 'add_column',
        field: { name: 'code', type: 'text', unique: true, required: true, defaultValue: "O'x" },
      },
      { kind: 'add_column', field: { name: 'note', type: 'text', unique: false } },
      { kind: 'drop_column', column: 'legacy' },
      { kind: 'rename_column', from: 'sku', to: 'ref' },
    ]);

    expect(db.executed(/ALTER TABLE "_zv_ghost_zvd_items"/).map((q) => q.sql)).toEqual([
      `ALTER TABLE "_zv_ghost_zvd_items" ADD COLUMN "code" text NOT NULL DEFAULT 'O''x'`,
      // The per-tenant key, on the ghost and named after the final table.
      'ALTER TABLE "_zv_ghost_zvd_items" ADD CONSTRAINT "zvd_items_tenant_id_code_key" UNIQUE (tenant_id, "code")',
      'ALTER TABLE "_zv_ghost_zvd_items" ADD COLUMN "note" text',
      'ALTER TABLE "_zv_ghost_zvd_items" DROP COLUMN "legacy"',
      'ALTER TABLE "_zv_ghost_zvd_items" RENAME COLUMN "sku" TO "ref"',
    ]);
  });

  const forbidden: [string, unknown][] = [
    ['a raw SQL fragment', 'ADD COLUMN x text, DROP COLUMN tenant_id'],
    ['an unknown kind', { kind: 'add_constraint', sql: 'CHECK (true)' }],
    ['dropping tenant_id', { kind: 'drop_column', column: 'tenant_id' }],
    ['dropping id', { kind: 'drop_column', column: 'id' }],
    ['renaming tenant_id away', { kind: 'rename_column', from: 'tenant_id', to: 'x' }],
    ['renaming onto id', { kind: 'rename_column', from: 'x', to: 'id' }],
    ['adding tenant_id', { kind: 'add_column', field: { name: 'tenant_id', type: 'text' } }],
    [
      'a field name that closes its quote',
      {
        kind: 'add_column',
        field: { name: 'x" text, DROP COLUMN tenant_id, ADD COLUMN "y', type: 'text' },
      },
    ],
    ['a column carrying a statement', { kind: 'drop_column', column: 'x; DROP TABLE "user"' }],
    // Postgres would cut it to 63 bytes, possibly onto a column that exists.
    ['a name past 63 bytes', { kind: 'rename_column', from: 'a', to: 'x'.repeat(64) }],
    ['a virtual field', { kind: 'add_column', field: { name: 'total', type: 'computed' } }],
    ['an unknown field type', { kind: 'add_column', field: { name: 'x', type: 'notarealtype' } }],
  ];

  for (const [what, op] of forbidden) {
    it(`refuses ${what} before creating anything`, async () => {
      const db = new CannedDb();
      await expect(
        GhostDDL.createGhost(asDb(db), 'zvd_items', [op as GhostOperation]),
      ).rejects.toThrow();
      expect(db.log).toEqual([]);
    });
  }

  it('has no string entry point', () => {
    expect('isAllowedGhostDdl' in ghostModule).toBe(false);
    // @ts-expect-error a raw fragment is not an operation
    const raw: GhostOperation = 'DROP COLUMN tenant_id';
    // @ts-expect-error no operation carries SQL
    const constraint: GhostOperation = { kind: 'add_constraint', sql: 'CHECK (true)' };
    expect([raw, constraint]).toHaveLength(2);
  });
});
