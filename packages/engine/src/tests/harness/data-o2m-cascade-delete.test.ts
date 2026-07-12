/**
 * Phase C — o2m ON DELETE CASCADE via /api/relations + data DELETE parent.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const PARENT = `ho2mdp_${Date.now()}`;
const CHILD = `ho2mdc_${Date.now()}`;

d('data o2m cascade on delete (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let parentId = '';
  let childId = '';
  let relationId = '';

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
    await DDLManager.createCollection(db, { name: CHILD, fields: [textField] });

    const rel = await app.request('/api/relations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `${PARENT}_kids`,
        type: 'o2m',
        source_collection: PARENT,
        source_field: 'kids',
        target_collection: CHILD,
        target_field: 'parent_id',
        on_delete: 'CASCADE',
      }),
    });
    expect(rel.status).toBe(201);
    relationId = ((await rel.json()) as { relation: { id: string } }).relation.id;

    const pRes = await app.request(`/api/data/${PARENT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'o2m-parent' }),
    });
    expect([200, 201]).toContain(pRes.status);
    parentId = ((await pRes.json()) as { id: string }).id;

    const cRes = await app.request(`/api/data/${CHILD}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'o2m-child', parent_id: parentId }),
    });
    expect([200, 201]).toContain(cRes.status);
    childId = ((await cRes.json()) as { id: string }).id;
  });

  afterAll(async () => {
    if (!db) return;
    if (relationId) {
      await db
        .deleteFrom('zvd_relations')
        .where('id', '=', relationId)
        .execute()
        .catch(() => {});
    }
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

  it('DELETE parent cascades to child rows linked by parent_id', async () => {
    const del = await app.request(`/api/data/${PARENT}/${parentId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(del.status);

    const row = await sql<{ id: string }>`
      SELECT id FROM ${sql.id(`zvd_${CHILD}`)} WHERE id = ${childId}
    `.execute(db);
    expect(row.rows.length).toBe(0);
  });
});
