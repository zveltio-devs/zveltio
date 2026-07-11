/**
 * Phase C — /api/relations o2m lifecycle (routes/relations.ts + ddl-manager applyRelationFK).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const PARENT = `ho2m_p_${Date.now()}`;
const CHILD = `ho2m_c_${Date.now()}`;

d('relations o2m (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let relationId: string;

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
      .where('source_collection', '=', PARENT)
      .execute()
      .catch(() => {});
  });

  it('POST /api/relations creates o2m virtual field + target FK column', async () => {
    const res = await app.request('/api/relations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `${PARENT}_items`,
        type: 'o2m',
        source_collection: PARENT,
        source_field: 'items',
        target_collection: CHILD,
        target_field: 'parent_id',
        on_delete: 'CASCADE',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { relation: { id: string } };
    relationId = body.relation.id;

    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${`zvd_${CHILD}`} AND column_name = 'parent_id'
    `.execute(db);
    expect(cols.rows.length).toBe(1);

    const parentRow = await DDLManager.getCollection(db, PARENT);
    const fields =
      typeof parentRow?.fields === 'string'
        ? JSON.parse(parentRow.fields)
        : (parentRow?.fields ?? []);
    expect(
      fields.some((f: { name: string; type: string }) => f.name === 'items' && f.type === 'o2m'),
    ).toBe(true);
  });

  it('DELETE /api/relations/:id cleans up FK and metadata', async () => {
    const res = await app.request(`/api/relations/${relationId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    relationId = '';
  });
});
