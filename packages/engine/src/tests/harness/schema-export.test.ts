/**
 * `GET /api/admin/schema/export`: the live schema as files, byte-stable.
 *
 * A pull with no change must produce no diff, so the output is checked twice
 * for the same bytes, and its keys for sorted order. What is out of the
 * artifact — engine collections and grants scoped to one tenant — is checked
 * as absent, not assumed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { serialize } from '../../lib/schema-artifact/export.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = 'schema_export_probe';
const ROLE = 'schema_export_role';
const TENANT = '00000000-0000-0000-0000-0000000000aa';

d('schema export', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;

  const pull = async () => {
    const res = await app.request('/api/admin/schema/export', { headers: { cookie } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { files: Record<string, string> }).files;
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      displayName: 'Probe',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'body', type: 'text' },
      ],
    } as never);
    await sql`INSERT INTO zvd_rls_policies (collection, role, filter_field, filter_value_source)
              VALUES (${COLLECTION}, ${ROLE}, 'title', 'user.id')`.execute(db);
    await sql`INSERT INTO zvd_column_permissions (collection_name, column_name, role, can_read, can_write)
              VALUES (${COLLECTION}, 'body', ${ROLE}, true, false)`.execute(db);
    await sql`INSERT INTO zvd_permissions (ptype, v0, v1, v2, v3) VALUES
                ('p', ${ROLE}, '*', ${COLLECTION}, 'update'),
                ('p', ${ROLE}, '*', ${COLLECTION}, 'read'),
                ('p', ${ROLE}, ${TENANT}, ${COLLECTION}, 'delete')`.execute(db);
  });

  afterAll(async () => {
    await sql`DELETE FROM zvd_permissions WHERE v0 = ${ROLE}`.execute(db);
    await sql`DELETE FROM zvd_rls_policies WHERE role = ${ROLE}`.execute(db);
    await sql`DELETE FROM zvd_column_permissions WHERE role = ${ROLE}`.execute(db);
    await dropTestCollection(db, COLLECTION);
  });

  it('writes a collection with its fields, row rules and column permissions', async () => {
    const files = await pull();
    const col = JSON.parse(files[`collections/${COLLECTION}.json`]);
    expect(col.name).toBe(COLLECTION);
    expect(col.displayName).toBe('Probe');
    expect(col.fields.map((f: { name: string }) => f.name)).toEqual(['title', 'body']);
    expect(col.fields[0].required).toBe(true);
    // A false flag is the default and is not written.
    expect('required' in col.fields[1]).toBe(false);
    expect(col.rowRules).toEqual([{ role: ROLE, field: 'title', op: 'eq', value: 'user.id' }]);
    expect(col.columnPermissions).toEqual([
      { role: ROLE, column: 'body', read: true, write: false },
    ]);
  });

  it('keeps global grants and leaves tenant-scoped ones out', async () => {
    const roles = JSON.parse((await pull())['roles.json']).roles as {
      name: string;
      permissions: { resource: string; actions: string[] }[];
    }[];
    expect(roles.find((r) => r.name === ROLE)?.permissions).toEqual([
      { resource: COLLECTION, actions: ['read', 'update'] },
    ]);
  });

  it('leaves engine collections out', async () => {
    const system = await sql<{ name: string }>`
      SELECT name FROM zvd_collections WHERE is_system LIMIT 1`.execute(db);
    const files = await pull();
    for (const { name } of system.rows) expect(files[`collections/${name}.json`]).toBeUndefined();
  });

  it('gives the same bytes twice, with sorted keys', async () => {
    const a = await pull();
    expect(await pull()).toEqual(a);
    for (const content of Object.values(a)) {
      expect(serialize(JSON.parse(content))).toBe(content);
    }
    expect(Object.keys(JSON.parse(a[`collections/${COLLECTION}.json`]))).toEqual([
      '$schema',
      'name',
      'columnPermissions',
      'displayName',
      'fields',
      'icon',
      'isPermissioned',
      'relations',
      'routeGroup',
      'rowRules',
      'singularName',
      'sort',
      'validation',
    ]);
  });

  it('is refused without an instance admin', async () => {
    expect((await app.request('/api/admin/schema/export')).status).toBe(401);
  });
});
