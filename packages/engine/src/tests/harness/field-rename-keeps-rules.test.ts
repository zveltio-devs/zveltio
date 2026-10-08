/**
 * A renamed field keeps the rules written against it.
 *
 * Column permissions, row rules and validation rules name a field by its
 * column name. `alterField` renamed the column and the collection's metadata
 * and left those three tables naming the old one, so:
 *
 *   - a column hidden from a role was shown to it under the new name — column
 *     permissions are a deny list, and nothing denied the new name;
 *   - a row rule on the field filtered on a column that no longer existed;
 *   - a validation rule stopped applying.
 *
 * `PATCH /api/collections/:name/fields/:field` and a `renameField` schema
 * migration both run `alterField`, so this pins the route.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { getEnforcer, invalidateUserPermCache } from '../../lib/tenancy/permissions.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hrename_rules_${Date.now()}`;

d('renaming a field carries its column permissions and rules', () => {
  let app: Hono;
  let db: Database;
  let godCookie = '';
  let memberCookie = '';
  let memberUserId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    godCookie = await createGodSession(app, db);

    const email = `harness-rename-rules-${Date.now()}@test.local`;
    const password = 'MemberUser123!';
    const signUp = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: 'Member' }),
    });
    memberUserId = ((await signUp.json()) as { user?: { id: string } }).user?.id ?? '';
    await sql`UPDATE "user" SET role = 'member' WHERE id = ${memberUserId}`.execute(db);
    await (await getEnforcer()).addPolicy(memberUserId, '*', COLLECTION, 'read');
    await invalidateUserPermCache(memberUserId);
    const signIn = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    memberCookie = (signIn.headers.get('set-cookie') ?? '')
      .split(',')
      .map((c) => c.split(';')[0]!.trim())
      .filter(Boolean)
      .join('; ');

    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'salary', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    const created = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({ title: 'row', salary: '100000' }),
    });
    expect(created.status).toBeLessThan(300);

    const perm = await app.request('/api/admin/column-permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({
        collection_name: COLLECTION,
        column_name: 'salary',
        role: 'member',
        can_read: false,
        can_write: false,
      }),
    });
    expect([200, 201]).toContain(perm.status);
    await sql`INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_op, filter_value_source)
              VALUES (${COLLECTION}, 'finance', 'salary', 'eq', 'static:1')`.execute(db);
    await sql`INSERT INTO zv_validation_rules (collection, field_name, rule_type, rule_config, error_message)
              VALUES (${COLLECTION}, 'salary', 'required', 'null'::jsonb, 'needed')`.execute(db);
  });

  afterAll(async () => {
    if (!db) return;
    await sql`DELETE FROM zvd_column_permissions WHERE collection_name = ${COLLECTION}`.execute(db);
    await sql`DELETE FROM zvd_rls_policies WHERE collection = ${COLLECTION}`.execute(db);
    await sql`DELETE FROM zv_validation_rules WHERE collection = ${COLLECTION}`.execute(db);
    if (memberUserId) {
      await (await getEnforcer())
        .removePolicy(memberUserId, '*', COLLECTION, 'read')
        .catch(() => {});
    }
    await sql.raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`).execute(db);
    await db.deleteFrom('zvd_collections').where('name', '=', COLLECTION).execute();
  });

  it('the member still does not see the column after it is renamed', async () => {
    const before = await app.request(`/api/data/${COLLECTION}`, {
      headers: { cookie: memberCookie },
    });
    const beforeRow = ((await before.json()) as { records: Record<string, unknown>[] }).records[0];
    expect(beforeRow?.title).toBe('row');
    expect(beforeRow?.salary).toBeUndefined();

    const renamed = await app.request(`/api/collections/${COLLECTION}/fields/salary`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie: godCookie },
      body: JSON.stringify({ new_name: 'pay' }),
    });
    expect(renamed.status).toBe(200);

    const after = await app.request(`/api/data/${COLLECTION}`, {
      headers: { cookie: memberCookie },
    });
    expect(after.status).toBe(200);
    const afterRow = ((await after.json()) as { records: Record<string, unknown>[] }).records[0];
    expect(afterRow?.title).toBe('row');
    expect(afterRow?.pay).toBeUndefined();
  });

  it('the rules name the new column', async () => {
    const names = await sql<{ src: string; name: string }>`
      SELECT 'colperm' AS src, column_name AS name FROM zvd_column_permissions WHERE collection_name = ${COLLECTION}
      UNION ALL SELECT 'rls', filter_field FROM zvd_rls_policies WHERE collection = ${COLLECTION}
      UNION ALL SELECT 'validation', field_name FROM zv_validation_rules WHERE collection = ${COLLECTION}
      ORDER BY 1`.execute(db);
    expect(names.rows).toEqual([
      { src: 'colperm', name: 'pay' },
      { src: 'rls', name: 'pay' },
      { src: 'validation', name: 'pay' },
    ]);
  });
});
