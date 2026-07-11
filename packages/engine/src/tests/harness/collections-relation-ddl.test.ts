/**
 * Phase C — collection create with m2o relation via routes + DDL queue.
 *
 * Provisions a parent table, then POST-creates a child collection with an m2o
 * FK field — exercising createCollection relation path in ddl-manager.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const PARENT = `hrpar_${Date.now()}`;
const CHILD = `hrchild_${Date.now()}`;

d('collections relation DDL (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: PARENT,
      fields: [{ name: 'name', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    if (!db) return;
    for (const name of [CHILD, PARENT]) {
      await sql
        .raw(`DROP TABLE IF EXISTS "zvd_${name}" CASCADE`)
        .execute(db)
        .catch(() => {});
      await db
        .deleteFrom('zvd_collections')
        .where('name', '=', name)
        .execute()
        .catch(() => {});
    }
    await db
      .deleteFrom('zvd_relations')
      .where('source_collection', '=', CHILD)
      .execute()
      .catch(() => {});
  });

  it('POST / creates a child collection with an m2o FK to the parent', async () => {
    const res = await app.request('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: CHILD,
        fields: [
          { name: 'title', type: 'text', required: true, unique: false, indexed: false },
          {
            name: 'parent',
            type: 'm2o',
            required: false,
            unique: false,
            indexed: true,
            options: { related_collection: PARENT, on_delete: 'SET NULL' },
          },
        ],
      }),
    });
    expect(res.status).toBe(202);
    expect(await DDLManager.tableExists(db, CHILD)).toBe(true);

    const rel = await db
      .selectFrom('zvd_relations')
      .selectAll()
      .where('source_collection', '=', CHILD)
      .where('source_field', '=', 'parent')
      .executeTakeFirst();
    expect(rel?.target_collection).toBe(PARENT);

    const fk = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${`zvd_${CHILD}`} AND column_name = 'parent'
    `.execute(db);
    expect(fk.rows.length).toBe(1);
  });
});
