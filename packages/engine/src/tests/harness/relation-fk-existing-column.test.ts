/**
 * A relation over a column that already exists gets its foreign key (DR-39).
 *
 * `applyRelationFK` ran `ADD COLUMN IF NOT EXISTS … REFERENCES`: on an existing
 * column PostgreSQL skips the whole clause, the key with it, and the relation
 * was recorded with nothing enforcing it. An o2m whose `target_field` names a
 * column the target already has is the common case. The key is now added
 * `NOT VALID` and validated after the commit; rows that break it, or a column
 * that is not a uuid, refuse the relation and leave no key and no row.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  asTenant,
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT = '00000000-0000-0000-0000-000000000001';
const SFX = Date.now();
const PARENT = `fke_p_${SFX}`;
const CHILD = `fke_c_${SFX}`;
const CT = `zvd_${CHILD}`;

d('a relation over an existing column', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let parentId = '';

  const post = async (body: Record<string, unknown>) => {
    const res = await app.request('/api/relations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ on_delete: 'CASCADE', on_update: 'CASCADE', ...body }),
    });
    return { status: res.status, body: await res.text() };
  };

  /** Every foreign key on the child's `column`, as the database holds it. */
  const keys = async (column: string) =>
    (
      await sql<{ valid: boolean; del: string; ref: string }>`
        SELECT c.convalidated AS valid, c.confdeltype::text AS del,
               c.confrelid::regclass::text AS ref
          FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         WHERE c.conrelid = ${CT}::regclass AND c.contype = 'f' AND a.attname = ${column}`.execute(
        db,
      )
    ).rows;

  const relations = async (name: string) =>
    (await sql`SELECT 1 FROM zvd_relations WHERE name = ${name}`.execute(db)).rows.length;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: PARENT,
      fields: [{ name: 'title', type: 'text' }],
    } as never);
    await DDLManager.createCollection(db, {
      name: CHILD,
      fields: [
        { name: 'title', type: 'text' },
        { name: 'parent_ref', type: 'uuid' },
        { name: 'other_ref', type: 'uuid' },
        { name: 'parent_txt', type: 'text' },
      ],
    } as never);
    parentId = (
      await asTenant(db, TENANT, (trx) =>
        sql<{
          id: string;
        }>`INSERT INTO ${sql.id(`zvd_${PARENT}`)} (title) VALUES ('p') RETURNING id`.execute(trx),
      )
    ).rows[0]!.id;
    await asTenant(db, TENANT, (trx) =>
      sql`INSERT INTO ${sql.id(CT)} (title, parent_ref, other_ref)
          VALUES ('ok', ${parentId}::uuid, NULL), ('orphan', NULL, gen_random_uuid())`.execute(trx),
    );
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_relations WHERE source_collection IN (${CHILD}, ${PARENT})`.execute(
      db,
    );
    await dropTestCollection(db, CHILD);
    await dropTestCollection(db, PARENT);
  });

  it("an o2m whose target_field already exists puts the key on it, validated", async () => {
    const res = await post({
      name: `${PARENT}_children`,
      type: 'o2m',
      source_collection: PARENT,
      source_field: 'children',
      target_collection: CHILD,
      target_field: 'parent_ref',
    });
    expect(res.status, res.body).toBe(201);
    expect(await keys('parent_ref')).toEqual([
      { valid: true, del: 'c', ref: `zvd_${PARENT}` },
    ]);
  }, 30_000);

  it('rows that break the key refuse the relation; no key, no relation row', async () => {
    const name = `${CHILD}_other_ref`;
    const res = await post({
      name,
      type: 'm2o',
      source_collection: CHILD,
      source_field: 'other_ref',
      target_collection: PARENT,
    });
    expect(res.status, res.body).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await keys('other_ref')).toEqual([]);
    expect(await relations(name)).toBe(0);

    // Once the row is gone, the same relation goes in, with its key.
    await asTenant(db, TENANT, (trx) =>
      sql`UPDATE ${sql.id(CT)} SET other_ref = NULL WHERE title = 'orphan'`.execute(trx),
    );
    const again = await post({
      name,
      type: 'm2o',
      source_collection: CHILD,
      source_field: 'other_ref',
      target_collection: PARENT,
    });
    expect(again.status, again.body).toBe(201);
    expect(await keys('other_ref')).toEqual([{ valid: true, del: 'c', ref: `zvd_${PARENT}` }]);
  }, 30_000);

  it('a column that is not a uuid refuses the relation', async () => {
    const name = `${CHILD}_parent_txt`;
    const res = await post({
      name,
      type: 'm2o',
      source_collection: CHILD,
      source_field: 'parent_txt',
      target_collection: PARENT,
    });
    expect(res.status, res.body).toBe(400);
    expect(res.body).toContain('uuid');
    expect(await keys('parent_txt')).toEqual([]);
    expect(await relations(name)).toBe(0);
  }, 30_000);
});
