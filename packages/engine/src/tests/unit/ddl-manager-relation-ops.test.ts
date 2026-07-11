/**
 * DDLManager relation helpers (lib/data/ddl-manager.ts) — FK, junction, registerRelation.
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

describe('DDLManager.applyRelationFK', () => {
  it('adds an FK column and concurrent index', async () => {
    const db = new CannedDb();
    await DDLManager.applyRelationFK(
      asDb(db),
      'zvd_orders',
      'customer_id',
      'zvd_customers',
      'SET NULL',
      'CASCADE',
    );
    expect(db.executed(/ADD COLUMN IF NOT EXISTS "customer_id" UUID/)).toHaveLength(1);
    expect(db.executed(/CREATE INDEX CONCURRENTLY.*customer_id/)).toHaveLength(1);
  });

  it('rejects unsafe on_delete values', async () => {
    const db = new CannedDb();
    await expect(
      DDLManager.applyRelationFK(asDb(db), 'zvd_a', 'x_id', 'zvd_b', 'DROP TABLE', 'CASCADE'),
    ).rejects.toThrow('Invalid on_delete/on_update');
  });
});

describe('DDLManager.createJunctionTable', () => {
  it('creates a junction table with FK columns and indexes', async () => {
    const db = new CannedDb();
    const name = await DDLManager.createJunctionTable(asDb(db), 'articles', 'tags');
    expect(name).toBe('zvd_jnc_articles_tags');
    expect(db.executed(/CREATE TABLE IF NOT EXISTS "zvd_jnc_articles_tags"/)).toHaveLength(1);
    expect(db.executed(/CREATE INDEX CONCURRENTLY.*articles_id/)).toHaveLength(1);
  });
});

describe('DDLManager.registerRelation', () => {
  it('inserts relation metadata with ON CONFLICT DO NOTHING', async () => {
    const db = new CannedDb();
    await DDLManager.registerRelation(asDb(db), {
      name: 'articles_author',
      type: 'm2o',
      source_collection: 'articles',
      source_field: 'author_id',
      target_collection: 'authors',
      target_field: 'id',
    });
    expect(db.executed(/insert into "zvd_relations"/i)).toHaveLength(1);
  });
});
