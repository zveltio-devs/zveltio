/**
 * A `unique: true` field is unique per tenant, on every road a column is born.
 *
 * Every `zvd_*` table carries `tenant_id` and is FORCE-RLS'd on it, but the
 * column builder wrote a column-level `UNIQUE`, i.e. `UNIQUE (code)` across the
 * whole table. Tenant B could not take a value tenant A held, was refused over a
 * row RLS hides from it, and could probe for another company's emails or codes
 * through the refusal. The key is `UNIQUE (tenant_id, code)` now — on create,
 * on the DDL-queue addField, on the add-field route and on a schema-branch merge.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'kysely';
import type { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { parseMigrationFile } from '../../db/migrations/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TENANT_A = '00000000-0000-0000-0000-000000000001';
const TENANT_B = '00000000-0000-0000-0000-0000000000fe';
const SFX = Date.now();
const COLLECTION = `uniq_tenant_${SFX}`;
const TABLE = `zvd_${COLLECTION}`;
const LEGACY = `uniq_legacy_${SFX}`;
/** A `zvd_*` table no collection owns — an extension's, with its own key. */
const FOREIGN = `zvd_uniq_ext_${SFX}`;

const field = (name: string, unique: boolean) => ({
  name,
  type: 'text',
  required: false,
  unique,
  indexed: false,
});

d('a unique field is unique per tenant', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  /** Inserts `value` into `column` as `tenant`; returns the SQLSTATE or 'ok'. */
  const put = async (column: string, value: string, tenant: string): Promise<string> => {
    try {
      await sql`
        INSERT INTO ${sql.id(TABLE)} (${sql.id(column)}, tenant_id) VALUES (${value}, ${tenant}::uuid)
      `.execute(db);
      return 'ok';
    } catch (err) {
      return String((err as { errno?: string }).errno ?? err);
    }
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);

    // Road 1: createCollection.
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [field('code', true), field('plain', false)],
    } as never);
    // Road 2: the DDL-queue addField.
    await DDLManager.addField(db, COLLECTION, field('ref', true) as never);
    // Road 3: the add-field route.
    const added = await app.request(`/api/collections/${COLLECTION}/fields`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(field('sku', true)),
    });
    expect(added.status).toBeLessThan(300);
    // Road 4: a schema-branch merge (small table: the dynamicAddColumn road).
    const created = await app.request('/api/schema/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: `uniq-${SFX}` }),
    });
    expect(created.status).toBe(201);
    const { branch, schema } = (await created.json()) as { branch: { id: string }; schema: string };
    const change = await app.request(`/api/schema/branches/${branch.id}/changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        type: 'add_field',
        payload: { collection: COLLECTION, field: field('tag', true) },
      }),
    });
    expect(change.status).toBeLessThan(300);
    const merged = await app.request(`/api/schema/branches/${branch.id}/merge`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(((await merged.json()) as { errors: string[] }).errors).toEqual([]);
    await db.deleteFrom('zv_schema_branches').where('id', '=', branch.id).execute();
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(db);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    await dropTestCollection(db, COLLECTION);
    await dropTestCollection(db, LEGACY);
    await sql`DROP TABLE IF EXISTS ${sql.id(FOREIGN)}`.execute(db);
  });

  for (const column of ['code', 'ref', 'sku', 'tag']) {
    it(`${column}: the same value in two tenants is two rows, twice in one tenant is refused`, async () => {
      expect(await put(column, 'X-1', TENANT_A)).toBe('ok');
      expect(await put(column, 'X-1', TENANT_B)).toBe('ok');
      expect(await put(column, 'X-1', TENANT_A)).toBe('23505');
      expect(await put(column, 'X-1', TENANT_B)).toBe('23505');
    });
  }

  it('the key is (tenant_id, column), and a non-unique field has none', async () => {
    const keys = await sql<{ def: string }>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = ${TABLE}::regclass AND contype = 'u' ORDER BY 1
    `.execute(db);
    expect(keys.rows.map((r) => r.def)).toEqual([
      'UNIQUE (tenant_id, code)',
      'UNIQUE (tenant_id, ref)',
      'UNIQUE (tenant_id, sku)',
      'UNIQUE (tenant_id, tag)',
    ]);
  });

  it('a duplicate through the API names the field, not the tenant', async () => {
    const post = () =>
      app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ code: 'API-1' }),
      });
    expect((await post()).status).toBe(201);
    const dup = await post();
    expect(dup.status).toBe(409);
    // The problem envelope carries the mapped message. Before, the key was
    // global, and widened to `(tenant_id, code)` without the mapper knowing,
    // it read "the same tenant_id, code … (value: <tenant uuid>, API-1)".
    const body = (await dup.json()) as { errors?: string[] };
    expect(body.errors).toEqual(['A record with the same code already exists (value: API-1).']);
  });

  it('migration 036 widens the keys an older build wrote, and only those', async () => {
    // What every build before this one wrote for a unique field.
    await DDLManager.createCollection(db, {
      name: LEGACY,
      fields: [field('email', false)],
    } as never);
    const legacy = `zvd_${LEGACY}`;
    await sql`ALTER TABLE ${sql.id(legacy)} ADD UNIQUE (email)`.execute(db);
    await sql`
      CREATE TABLE ${sql.id(FOREIGN)} (id uuid PRIMARY KEY, code text UNIQUE, tenant_id uuid NOT NULL)
    `.execute(db);

    const file = Bun.file(
      new URL('../../db/migrations/sql/036_collection_unique_keys_per_tenant.sql', import.meta.url),
    );
    await sql.raw(parseMigrationFile(await file.text()).up).execute(db);

    const keys = async (table: string) =>
      (
        await sql<{ def: string }>`
          SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = ${table}::regclass AND contype = 'u'
        `.execute(db)
      ).rows.map((r) => r.def);
    expect(await keys(legacy)).toEqual(['UNIQUE (tenant_id, email)']);
    expect(await keys(FOREIGN)).toEqual(['UNIQUE (code)']);
    for (const tenant of [TENANT_A, TENANT_B]) {
      await sql`INSERT INTO ${sql.id(legacy)} (email, tenant_id) VALUES ('a@x', ${tenant}::uuid)`.execute(
        db,
      );
    }
  });
});
