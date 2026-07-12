/**
 * Phase C — m2o ON DELETE SET NULL when parent row is removed (write-pipeline + FK).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const PARENT = `hnullp_${Date.now()}`;
const CHILD = `hnullc_${Date.now()}`;

d('data m2o set null on delete (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let parentId = '';
  let childId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const textField = {
      name: 'title',
      type: 'text',
      required: true,
      unique: false,
      indexed: false,
    } as never;

    await DDLManager.createCollection(db, { name: PARENT, fields: [textField] });
    await DDLManager.createCollection(db, {
      name: CHILD,
      fields: [
        textField,
        {
          name: 'owner',
          type: 'm2o',
          required: false,
          unique: false,
          indexed: false,
          options: { related_collection: PARENT, on_delete: 'SET NULL' },
        },
      ],
    } as never);

    const pRes = await app.request(`/api/data/${PARENT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'parent-row' }),
    });
    expect([200, 201]).toContain(pRes.status);
    parentId = ((await pRes.json()) as { id: string }).id;

    const cRes = await app.request(`/api/data/${CHILD}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'child-row', owner: parentId }),
    });
    expect([200, 201]).toContain(cRes.status);
    childId = ((await cRes.json()) as { id: string }).id;
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
  });

  it('DELETE parent nulls the child m2o FK column', async () => {
    const del = await app.request(`/api/data/${PARENT}/${parentId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(del.status);

    const row = await sql<{ owner: string | null }>`
      SELECT owner FROM ${sql.id(`zvd_${CHILD}`)} WHERE id = ${childId}
    `.execute(db);
    expect(row.rows[0]?.owner).toBeNull();
  });
});
