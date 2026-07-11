/**
 * ddl-queue runCreateRelation / runDropRelation — m2m junction path (_internalForTests).
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const { runCreateRelation, runDropRelation } = await import('../../lib/data/ddl-queue.js').then(
  (m) => m._internalForTests,
);

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

describe('ddl-queue runCreateRelation m2m', () => {
  it('creates a junction table when type is m2m', async () => {
    const db = new CannedDb();
    await runCreateRelation(asDb(db), {
      type: 'm2m',
      source_collection: 'articles',
      target_collection: 'tags',
      junction_table: 'zvd_jnc_articles_tags',
    });
    expect(db.executed(/CREATE TABLE IF NOT EXISTS zvd_jnc_articles_tags/)).toHaveLength(1);
  });

  it('rejects invalid identifiers for m2o', async () => {
    const db = new CannedDb();
    await expect(
      runCreateRelation(asDb(db), {
        type: 'm2o',
        source_collection: 'Bad-Name',
        target_collection: 'tags',
        source_field: 'tag_id',
      }),
    ).rejects.toThrow('Invalid identifier');
  });
});

describe('ddl-queue runDropRelation m2m', () => {
  it('drops a junction table for m2m relations', async () => {
    const db = new CannedDb();
    await runDropRelation(asDb(db), {
      type: 'm2m',
      junction_table: 'zvd_jnc_orders_items',
    });
    expect(db.executed(/DROP TABLE IF EXISTS zvd_jnc_orders_items CASCADE/)).toHaveLength(1);
  });
});
