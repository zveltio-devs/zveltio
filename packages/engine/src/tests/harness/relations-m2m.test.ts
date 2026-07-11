/**
 * Phase C — /api/relations m2m junction lifecycle (routes/relations.ts + ddl-manager).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const A = `hm2m_a_${Date.now()}`;
const B = `hm2m_b_${Date.now()}`;

d('relations m2m (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let relationId: string;
  let junctionTable: string;

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
    await DDLManager.createCollection(db, { name: A, fields: [textField] });
    await DDLManager.createCollection(db, { name: B, fields: [textField] });
  });

  afterAll(async () => {
    if (!db) return;
    if (junctionTable) {
      await sql
        .raw(`DROP TABLE IF EXISTS "${junctionTable}" CASCADE`)
        .execute(db)
        .catch(() => {});
    }
    for (const name of [A, B]) {
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
      .where('source_collection', '=', A)
      .execute()
      .catch(() => {});
  });

  it('POST /api/relations creates m2m junction + virtual fields', async () => {
    const res = await app.request('/api/relations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `${A}_tags`,
        type: 'm2m',
        source_collection: A,
        source_field: 'tags',
        target_collection: B,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      relation: { id: string; junction_table?: string };
    };
    relationId = body.relation.id;
    junctionTable = body.relation.junction_table ?? '';
    expect(junctionTable).toContain('jnc');

    const exists = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = ${junctionTable}
      ) AS exists
    `.execute(db);
    expect(exists.rows[0]?.exists).toBe(true);

    const row = await DDLManager.getCollection(db, A);
    const fields = typeof row?.fields === 'string' ? JSON.parse(row.fields) : (row?.fields ?? []);
    expect(
      fields.some((f: { name: string; type: string }) => f.name === 'tags' && f.type === 'm2m'),
    ).toBe(true);
  });

  it('DELETE /api/relations/:id drops the junction table', async () => {
    const res = await app.request(`/api/relations/${relationId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    if (junctionTable) {
      const exists = await sql<{ exists: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables WHERE table_name = ${junctionTable}
        ) AS exists
      `.execute(db);
      expect(exists.rows[0]?.exists).toBe(false);
    }
    relationId = '';
  });
});
