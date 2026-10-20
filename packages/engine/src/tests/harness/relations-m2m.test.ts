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

  it('DELETE refuses an m2m relation whose junction an extension made, before any change', async () => {
    // crm registers `contact_organizations` over its own table. The engine
    // drops only the `zvd_jnc_*` tables it makes; before, the delete removed
    // the source field's metadata and then threw on the junction name.
    const junction = `zvd_extjnc_${Date.now()}`;
    await sql.raw(`CREATE TABLE "${junction}" (id uuid PRIMARY KEY)`).execute(db);
    const rel = await db
      .insertInto('zvd_relations')
      .values({
        name: `ext_rel_${Date.now()}`,
        type: 'm2m',
        source_collection: A,
        source_field: 'title',
        target_collection: B,
        junction_table: junction,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    try {
      const res = await app.request(`/api/relations/${rel.id}`, {
        method: 'DELETE',
        headers: { cookie },
      });
      expect(res.status).toBe(409);
      const left = await db
        .selectFrom('zvd_relations')
        .select('id')
        .where('id', '=', rel.id)
        .execute();
      expect(left).toHaveLength(1);
      expect(await DDLManager.tableExists(db, junction.slice(4))).toBe(true);
      const fields = await db
        .selectFrom('zvd_collections')
        .select('fields')
        .where('name', '=', A)
        .executeTakeFirstOrThrow();
      expect(JSON.stringify(fields.fields)).toContain('"title"');
    } finally {
      await db.deleteFrom('zvd_relations').where('id', '=', rel.id).execute();
      await sql.raw(`DROP TABLE IF EXISTS "${junction}"`).execute(db);
    }
  });
});
