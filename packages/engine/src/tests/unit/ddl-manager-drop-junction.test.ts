/**
 * DDLManager.dropCollection m2m junction cleanup (lib/data/ddl-manager.ts).
 */

import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { Database } from '../../db/index.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';
import { DDLManager, fieldTypeRegistry } from '../../lib/data/index.js';
import { CannedDb } from './fixtures/canned-db.js';

registerCoreFieldTypes(fieldTypeRegistry);

function setup(): CannedDb {
  const db = new CannedDb();
  db.when(/SELECT EXISTS[\s\S]*pg_tables/i, (q) => [
    { exists: String(q.parameters[0]) === 'zvd_tags' },
  ]);
  db.when(/information_schema\.table_constraints/i, []);
  return db;
}

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

beforeEach(() => {
  DDLManager.invalidateCache();
});

describe('dropCollection m2m junction tables', () => {
  it('drops a stored junction_table name before the main table', async () => {
    const db = setup();
    db.when(/select "source_collection", "target_collection", "junction_table" from "zvd_relations"/i, [
      {
        source_collection: 'articles',
        target_collection: 'tags',
        junction_table: 'zvd_jnc_articles_tags',
      },
    ]);
    await DDLManager.dropCollection(asDb(db), 'tags');
    expect(db.executed(/DROP TABLE IF EXISTS "zvd_jnc_articles_tags" CASCADE/)).toHaveLength(1);
    expect(db.executed(/DROP TABLE IF EXISTS zvd_tags CASCADE/)).toHaveLength(1);
  });

  it('warns and continues when junction drop fails', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const db = setup();
      db.when(/select "source_collection", "target_collection", "junction_table" from "zvd_relations"/i, [
        {
          source_collection: 'articles',
          target_collection: 'tags',
          junction_table: 'zvd_jnc_articles_tags',
        },
      ]);
      db.fail(/DROP TABLE IF EXISTS "zvd_jnc_articles_tags"/i, new Error('locked'));
      await DDLManager.dropCollection(asDb(db), 'tags');
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('DROP TABLE zvd_jnc_articles_tags failed')),
      ).toBe(true);
      expect(db.executed(/DROP TABLE IF EXISTS zvd_tags CASCADE/)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
