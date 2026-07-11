/**
 * DDLManager.applyRelationFK + createCollection on_update paths (ddl-manager.ts).
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

describe('DDLManager.applyRelationFK — on_update', () => {
  it('rejects invalid on_update values', async () => {
    const db = new CannedDb();
    await expect(
      DDLManager.applyRelationFK(asDb(db), 'zvd_a', 'x', 'zvd_b', 'SET NULL', 'INVALID'),
    ).rejects.toThrow('Invalid on_delete/on_update');
  });

  it('creates FK with custom on_update through createCollection', async () => {
    const db = setup(['zvd_customers']);
    await DDLManager.createCollection(asDb(db), {
      name: 'orders',
      fields: [
        TEXT,
        {
          name: 'customer',
          type: 'm2o',
          required: false,
          unique: false,
          indexed: false,
          options: {
            related_collection: 'customers',
            on_delete: 'SET NULL',
            on_update: 'RESTRICT',
          },
        },
      ],
    } as never);

    expect(db.executed(/ON UPDATE RESTRICT/)).toHaveLength(1);
    const rel = db.executed(/insert into "zvd_relations"/)[0]!;
    expect(rel.parameters).toContain('RESTRICT');
  });
});
