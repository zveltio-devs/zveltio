/**
 * Two GhostDDL runs on one table at once.
 *
 * Unserialised, the second run's CREATE of `_zv_ghost_<table>` failed, and its
 * failure cleanup dropped the FIRST run's ghost and changelog mid-copy: both
 * runs failed, or the first swapped in a table missing the second's change.
 * A per-table advisory lock makes the second wait for the first.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, GhostDDL } from '../../lib/data/index.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hgconc_${Date.now()}`;

d('ghost DDL concurrent runs on one table', () => {
  let db: Database;
  const tableName = `zvd_${COLLECTION}`;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    if (!db) return;
    await dropTestCollection(db, COLLECTION).catch(() => {});
  });

  it('both runs complete and both columns land', async () => {
    const add = (name: string) =>
      GhostDDL.execute(db, tableName, [
        { kind: 'add_column', field: { name, type: 'text', required: false } },
      ]);
    const results = await Promise.allSettled([add('alpha'), add('beta')]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);

    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${tableName} AND column_name IN ('alpha', 'beta')
      ORDER BY column_name
    `.execute(db);
    expect(cols.rows.map((r) => r.column_name)).toEqual(['alpha', 'beta']);
  });
});
