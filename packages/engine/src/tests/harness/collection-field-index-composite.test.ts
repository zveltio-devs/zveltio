/**
 * An indexed field on a collection gets the tenant-first index too.
 *
 * A filtered listing is `WHERE <field> = x ORDER BY created_at DESC LIMIT n`.
 * The bare `(<field>)` index cannot serve it: to satisfy the ordering the
 * planner walks `created_at` instead and discards whatever the policy excludes.
 * Measured on 300 000 rows with the policy applied — 39,6 ms at ten tenants and
 * at a hundred alike, every row in the table thrown away to return twenty-five.
 *
 * The composite pays ONLY together with the explicit `tenant_id =`. With the
 * policy alone it changes nothing (41 ms either way), because `= ANY` over a
 * runtime array is not an index condition. At ten tenants:
 *
 *     equality alone            12,5 ms
 *     equality + this index      0,065 ms
 *
 * This is a test rather than a repo-wide gate on purpose. A gate demanding every
 * index on a tenant-scoped table lead with `tenant_id` matches 220 existing
 * ones, most of them foreign-key indexes serving joins — a ratchet of that size
 * with no reasons written is decoration, and Block C already refused one.
 * The invariant worth guarding is narrow: the engine's own index-creation path.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { dropTestCollection, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `fldidx_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;

d('an indexed field gets the tenant-first index', () => {
  let db: Database;

  beforeAll(async () => {
    ({ db } = await getTestApp());
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'code', type: 'text', required: false, unique: false, indexed: true },
        { name: 'note', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
  });

  afterAll(async () => {
    if (db) await dropTestCollection(db, COLLECTION);
  });

  it('creates both the bare and the tenant-first index for an indexed field', async () => {
    const r = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = ${TABLE}
    `.execute(db);
    const idx = r.rows.map((x) => x.indexname);
    expect(idx).toContain(`idx_${TABLE}_code`);
    expect(idx).toContain(`idx_${TABLE}_tenant_code`);
  }, 60_000);

  it('leaves a non-indexed field alone', async () => {
    const r = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = ${TABLE}
    `.execute(db);
    const idx = r.rows.map((x) => x.indexname);
    expect(idx).not.toContain(`idx_${TABLE}_note`);
    expect(idx).not.toContain(`idx_${TABLE}_tenant_note`);
  }, 60_000);
});
