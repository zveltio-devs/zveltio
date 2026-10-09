/**
 * A dropped field takes the rules written against it.
 *
 * Column permissions, row rules and validation rules name a field by column.
 * Every path that drops a field left them behind, so a field added again under
 * the same name inherited them: hidden from a role nobody hid it from, filtered
 * by a row rule written for different data, validated by a rule nobody set.
 *
 * Three paths drop a field: `dropField` (the route, schema migrations),
 * `DDLManager.removeField` (the DDL queue, schema-branch merge, extensions) and
 * deleting a relation (its FK column).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hdrop_rules_${Date.now()}`;
const TARGET = `hdrop_rules_t_${Date.now()}`;
const text = (name: string) => ({
  name,
  type: 'text',
  required: false,
  unique: false,
  indexed: false,
});

async function plantRules(app: Hono, db: Database, cookie: string, field: string) {
  await sql`INSERT INTO zvd_column_permissions (collection_name, column_name, role, can_read, can_write)
            VALUES (${COLLECTION}, ${field}, 'member', false, false)`.execute(db);
  // Through the route: it also writes the row-rule policy, which names the column.
  const rule = await app.request('/api/admin/rls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      collection: COLLECTION,
      role: 'finance',
      filter_field: field,
      filter_op: 'eq',
      // `owner` is the m2o's uuid column.
      filter_value_source: field === 'owner' ? `static:${crypto.randomUUID()}` : 'static:1',
    }),
  });
  expect(rule.status, await rule.clone().text()).toBe(201);
  await sql`INSERT INTO zv_validation_rules (collection, field_name, rule_type, rule_config, error_message)
            VALUES (${COLLECTION}, ${field}, 'required', 'null'::jsonb, 'needed')`.execute(db);
}

async function rulesOn(db: Database, field: string): Promise<string[]> {
  const r = await sql<{ src: string }>`
    SELECT 'colperm' AS src FROM zvd_column_permissions WHERE collection_name = ${COLLECTION} AND column_name = ${field}
    UNION ALL SELECT 'rls' FROM zvd_rls_policies WHERE collection = ${COLLECTION} AND filter_field = ${field}
    UNION ALL SELECT 'validation' FROM zv_validation_rules WHERE collection = ${COLLECTION} AND field_name = ${field}
    ORDER BY 1`.execute(db);
  return r.rows.map((x) => x.src);
}

d('dropping a field drops its column permissions and rules', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, { name: TARGET, fields: [text('label')] } as never);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        text('title'),
        text('salary'),
        text('bonus'),
        text('keep'),
        {
          name: 'owner',
          type: 'm2o',
          required: false,
          unique: false,
          indexed: false,
          options: { related_collection: TARGET },
        },
      ],
    } as never);
    for (const f of ['salary', 'bonus', 'keep', 'owner']) await plantRules(app, db, godCookie, f);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name = ${COLLECTION}`.execute(db);
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${COLLECTION}`.execute(db);
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${COLLECTION}`.execute(db);
    for (const c of [COLLECTION, TARGET]) {
      await db
        .deleteFrom('zvd_relations')
        .where((eb) => eb.or([eb('source_collection', '=', c), eb('target_collection', '=', c)]))
        .execute();
      await sql.raw(`DROP TABLE IF EXISTS "zvd_${c}" CASCADE`).execute(db);
      await db.deleteFrom('zvd_collections').where('name', '=', c).execute();
    }
  });

  it('DELETE /api/collections/:name/fields/:field', async () => {
    const res = await app.request(`/api/collections/${COLLECTION}/fields/salary`, {
      method: 'DELETE',
      headers: { cookie: godCookie },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await rulesOn(db, 'salary')).toEqual([]);
    expect(await rulesOn(db, 'keep')).toEqual(['colperm', 'rls', 'validation']);
  });

  it('DDLManager.removeField', async () => {
    await DDLManager.removeField(db, COLLECTION, 'bonus');
    expect(await rulesOn(db, 'bonus')).toEqual([]);
    expect(await rulesOn(db, 'keep')).toEqual(['colperm', 'rls', 'validation']);
  });

  it('DELETE /api/relations/:id', async () => {
    const rel = await db
      .selectFrom('zvd_relations')
      .select('id')
      .where('source_collection', '=', COLLECTION)
      .where('source_field', '=', 'owner')
      .executeTakeFirstOrThrow();
    const res = await app.request(`/api/relations/${rel.id}`, {
      method: 'DELETE',
      headers: { cookie: godCookie },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await rulesOn(db, 'owner')).toEqual([]);
    expect(await rulesOn(db, 'keep')).toEqual(['colperm', 'rls', 'validation']);
  });
});
