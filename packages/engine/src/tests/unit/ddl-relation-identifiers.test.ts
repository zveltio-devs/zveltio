/**
 * `create_relation` / `drop_relation` — the identifiers reach `sql.raw`.
 *
 * Every branch here interpolates names into a raw statement, so each one checks
 * `SAFE_NAME` first and throws rather than emitting. The junction-table branch
 * is the one that mattered: a create with a missing or unsafe junction name
 * created nothing and the job still reported `completed`, so a relation existed
 * in the collection metadata with no table behind it.
 *
 * These assert the refusals AND that a valid payload still emits — a guard that
 * refused everything would pass the first half of this file and break relations.
 */

import { describe, expect, it } from 'bun:test';
import { _internalForTests } from '../../lib/data/ddl-queue.js';
import { CannedDb } from './fixtures/canned-db.js';

const { runCreateRelation, runDropRelation } = _internalForTests;

const trxOf = (db: CannedDb): any => db.kysely;

describe('runCreateRelation — identifiers', () => {
  it('creates the junction table for a valid m2m payload', async () => {
    const db = new CannedDb();
    await runCreateRelation(trxOf(db), {
      type: 'm2m',
      junction_table: 'zvd_orders_tags',
      source_collection: 'orders',
      target_collection: 'tags',
    });
    expect(db.executed(/CREATE TABLE IF NOT EXISTS zvd_orders_tags/i).length).toBeGreaterThan(0);
  });

  it('refuses an m2m payload with no junction table, rather than creating nothing quietly', async () => {
    const db = new CannedDb();
    await expect(
      runCreateRelation(trxOf(db), {
        type: 'm2m',
        source_collection: 'orders',
        target_collection: 'tags',
      }),
    ).rejects.toThrow(/junction/i);
    expect(db.executed(/CREATE TABLE/i)).toHaveLength(0);
  });

  it('refuses an unsafe junction identifier', async () => {
    const db = new CannedDb();
    await expect(
      runCreateRelation(trxOf(db), {
        type: 'm2m',
        junction_table: 'x"; DROP TABLE zv_api_keys; --',
        source_collection: 'orders',
        target_collection: 'tags',
      }),
    ).rejects.toThrow();
    expect(db.executed(/DROP TABLE/i)).toHaveLength(0);
  });

  it('refuses a relation type it does not implement, instead of reporting success', async () => {
    // `o2m` and `m2a` are handled from the other side and are deliberately no-ops;
    // anything else is a payload nobody wrote a branch for.
    const db = new CannedDb();
    await expect(
      runCreateRelation(trxOf(db), {
        type: 'nonsense',
        source_collection: 'a',
        target_collection: 'b',
      }),
    ).rejects.toThrow(/unsupported relation type/i);
  });
});

describe('runDropRelation — identifiers', () => {
  it('drops the junction table for a valid m2m payload', async () => {
    const db = new CannedDb();
    await runDropRelation(trxOf(db), { type: 'm2m', junction_table: 'zvd_orders_tags' });
    expect(db.executed(/DROP TABLE IF EXISTS zvd_orders_tags/i).length).toBeGreaterThan(0);
  });

  it('refuses an unsafe junction identifier on drop too', async () => {
    const db = new CannedDb();
    await expect(
      runDropRelation(trxOf(db), { type: 'm2m', junction_table: 'a b; DROP DATABASE x' }),
    ).rejects.toThrow(/Invalid identifier/);
    expect(db.executed(/DROP/i)).toHaveLength(0);
  });

  it('refuses an unsupported relation type', async () => {
    const db = new CannedDb();
    await expect(runDropRelation(trxOf(db), { type: 'nonsense' })).rejects.toThrow(
      /unsupported relation type/i,
    );
  });
});
