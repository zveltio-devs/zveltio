/**
 * A schema-branch merge applies a change as strictly as the route that applies
 * it directly.
 *
 * `POST /branches/:id/changes` took `payload: z.record(z.any())`, and the merge
 * fed it to the DDL building blocks below the routes: on a table under 100k
 * rows `field.name` went into `getColumnDDL` and from there into `sql.raw`, and
 * `remove_field` dropped any column it was named — `tenant_id` included. Small
 * tables also took the column and its unique key in two transactions, created
 * no index for an `indexed` field, and never wrote the field into
 * `zvd_collections.fields`. The merge now goes through `DDLManager.addField` /
 * `removeField`, which the field routes' rules now live in.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SFX = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const COL = `sbmg_${SFX}`;
const TABLE = `zvd_${COL}`;

d('schema-branch merge guards (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  const branches: string[] = [];
  const schemas: string[] = [];

  const post = (path: string, body?: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  async function branch(): Promise<string> {
    const res = await post('/api/schema/branches', { name: `sbmg-${branches.length}-${SFX}` });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { branch: { id: string }; schema: string };
    branches.push(body.branch.id);
    schemas.push(body.schema);
    return body.branch.id;
  }

  const merge = async (id: string) =>
    (await (await post(`/api/schema/branches/${id}/merge`)).json()) as {
      applied: string[];
      errors: string[];
    };

  const columns = async () =>
    (
      await sql<{ name: string }>`
        SELECT column_name AS name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ${TABLE}
      `.execute(db)
    ).rows.map((r) => r.name);

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COL,
      fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
    } as never);
    for (let i = 0; i < 100 && !(await columns()).includes('title'); i++) await Bun.sleep(100);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    for (const id of branches) {
      await sql`DELETE FROM zv_schema_branches WHERE id = ${id}`.execute(db).catch(() => {});
    }
    for (const s of schemas) {
      await sql`DROP SCHEMA IF EXISTS ${sql.id(s)} CASCADE`.execute(db).catch(() => {});
    }
    await dropTestCollection(db, COL).catch(() => {});
  });

  it('refuses a field whose name is SQL, before it is stored', async () => {
    const id = await branch();
    const res = await post(`/api/schema/branches/${id}/changes`, {
      type: 'add_field',
      payload: {
        collection: COL,
        field: { name: 'x text, DROP COLUMN title --', type: 'text' },
      },
    });
    expect(res.status).toBe(400);
  });

  it('a change stored before the check is refused at merge and runs nothing', async () => {
    // A branch row written by an older engine still merges: the merge parses
    // again rather than trusting what is in `changes`.
    const id = await branch();
    const evil = [
      {
        type: 'add_field',
        payload: { collection: COL, field: { name: 'x text, DROP COLUMN title --', type: 'text' } },
      },
    ];
    await sql`
      UPDATE zv_schema_branches SET changes = ${JSON.stringify(evil)}::jsonb WHERE id = ${id}
    `.execute(db);

    const out = await merge(id);
    expect(out.applied).toEqual([]);
    expect(out.errors).toHaveLength(1);
    expect(await columns()).toContain('title');
  });

  it('refuses to drop or redefine a system column', async () => {
    const id = await branch();
    await post(`/api/schema/branches/${id}/changes`, {
      type: 'remove_field',
      payload: { collection: COL, field: 'tenant_id' },
    });
    // `created_at` exists, so ADD COLUMN IF NOT EXISTS is a no-op — and the
    // field would still be written into the collection's metadata.
    await post(`/api/schema/branches/${id}/changes`, {
      type: 'add_field',
      payload: { collection: COL, field: { name: 'created_at', type: 'text' } },
    });
    const out = await merge(id);
    expect(out.applied).toEqual([]);
    expect(out.errors.filter((e) => e.includes('system column'))).toHaveLength(2);
    expect(await columns()).toContain('tenant_id');
  });

  it('a merged field is complete: per-tenant key, its index, and its metadata', async () => {
    const id = await branch();
    const res = await post(`/api/schema/branches/${id}/changes`, {
      type: 'add_field',
      payload: {
        collection: COL,
        field: { name: 'code', type: 'text', required: false, unique: true, indexed: true },
      },
    });
    expect(res.status).toBe(200);

    const out = await merge(id);
    expect(out.errors).toEqual([]);
    expect(await columns()).toContain('code');

    const keys = await sql<{ def: string }>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = ${TABLE}::regclass AND contype = 'u'
    `.execute(db);
    expect(keys.rows.map((r) => r.def)).toContain('UNIQUE (tenant_id, code)');

    const indexes = await sql<{ def: string }>`
      SELECT indexdef AS def FROM pg_indexes WHERE tablename = ${TABLE}
    `.execute(db);
    expect(indexes.rows.some((r) => /\(code\)/.test(r.def) && !/UNIQUE/.test(r.def))).toBe(true);

    const meta = await sql<{ fields: unknown }>`
      SELECT fields FROM zvd_collections WHERE name = ${COL}
    `.execute(db);
    const raw = meta.rows[0]?.fields;
    const fields = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ name: string }>;
    expect(fields.map((f) => f.name)).toContain('code');
  });
});
