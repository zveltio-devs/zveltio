/**
 * `status` belongs to the collection, not the engine.
 *
 * Every collection used to get `status TEXT … CHECK (active|draft|archived)`,
 * which the data API stripped from every write and `introspectTable` skipped,
 * with no endpoint that ever set it. So no collection could have a writable
 * `status`: one declared in a schema was refused as a system column, and a
 * table that brought its own (CRM's `zvd_transactions`) had it dropped from
 * every insert and update and missing from its adopted fields.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile, splitSqlStatements } from '../../db/migrations/index.js';
import { DDLManager } from '../../lib/data/index.js';
import {
  createGodSession,
  dropTestCollection,
  getTestApp,
  harnessAvailable,
} from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const ADOPTED = `hstat_adopt_${Date.now()}`;
const DECLARED = `hstat_decl_${Date.now()}`;

d('a collection owns its status column', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  const json = (method: string, body: unknown) => ({
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    // An extension's table with a business `status`, adopted the way CRM's
    // `adoptCrmCollections` does: metadata with no fields, then introspection.
    await sql
      .raw(
        `CREATE TABLE "zvd_${ADOPTED}" (
           id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
           title TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'completed')),
           created_by TEXT,
           updated_by TEXT,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           tenant_id UUID NOT NULL DEFAULT COALESCE(NULLIF(current_setting('zveltio.current_tenant', true), '')::uuid, '00000000-0000-0000-0000-000000000001'::uuid)
         )`,
      )
      .execute(db);
    await DDLManager.registerMetadata(db, { name: ADOPTED, fields: [] } as never);
    await DDLManager.syncFieldsFromDB(db, ADOPTED);
  });

  afterAll(async () => {
    if (!db) return;
    await dropTestCollection(db, ADOPTED).catch(() => {});
    await dropTestCollection(db, DECLARED).catch(() => {});
  });

  it('an adopted table keeps its own status through write, update and filter', async () => {
    const row = await DDLManager.getCollection(db, ADOPTED);
    const fields = typeof row?.fields === 'string' ? JSON.parse(row.fields) : row?.fields;
    expect(fields.map((f: { name: string }) => f.name)).toContain('status');

    const created = await app.request(
      `/api/data/${ADOPTED}`,
      json('POST', { title: 'a', status: 'pending' }),
    );
    expect(created.status).toBe(201);
    const rec = (await created.json()) as { id: string; status: string };
    expect(rec.status).toBe('pending');

    const patched = await app.request(
      `/api/data/${ADOPTED}/${rec.id}`,
      json('PATCH', { status: 'completed' }),
    );
    expect(patched.status).toBe(200);
    const stored = await sql<{ status: string }>`
      SELECT status FROM ${sql.table(`zvd_${ADOPTED}`)} WHERE id = ${rec.id}
    `.execute(db);
    expect(stored.rows[0]?.status).toBe('completed');

    const listed = await app.request(`/api/data/${ADOPTED}?status[eq]=completed`, {
      headers: { cookie },
    });
    const body = (await listed.json()) as { records: Array<{ id: string }> };
    expect(body.records.map((r) => r.id)).toEqual([rec.id]);
  });

  it('a collection may declare a status field, and gets none it did not declare', async () => {
    await DDLManager.createCollection(db, {
      name: DECLARED,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        {
          name: 'status',
          type: 'enum',
          required: false,
          unique: false,
          indexed: false,
          options: { values: ['open', 'closed'] },
        },
      ],
    } as never);
    const created = await app.request(
      `/api/data/${DECLARED}`,
      json('POST', { title: 'b', status: 'closed' }),
    );
    expect(created.status).toBe(201);
    expect(((await created.json()) as { status: string }).status).toBe('closed');
    const bad = await app.request(
      `/api/data/${DECLARED}`,
      json('POST', { title: 'c', status: 'archived' }),
    );
    expect(bad.status).toBe(422);
    // `ADOPTED`'s own column aside, a collection that declares no status has none.
    const bare = `${DECLARED}_bare`;
    await DDLManager.createCollection(db, {
      name: bare,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    try {
      expect(await DDLManager.columnNames(db, bare)).not.toContain('status');
    } finally {
      await dropTestCollection(db, bare).catch(() => {});
    }
  });

  it('085 registers the status column a table already has as a field', async () => {
    const OLD = `${DECLARED}_old`;
    const EMPTY = `${DECLARED}_empty`;
    const fields = async (name: string) => {
      const r = await db
        .selectFrom('zvd_collections')
        .select('fields')
        .where('name', '=', name)
        .executeTakeFirstOrThrow();
      const f = typeof r.fields === 'string' ? JSON.parse(r.fields) : r.fields;
      return f as Array<{ name: string; type: string; options?: { values?: string[] } }>;
    };
    try {
      // A collection created before 085, with the engine's column.
      for (const name of [OLD, EMPTY]) {
        await DDLManager.createCollection(db, {
          name,
          fields: [{ name: 'title', type: 'text', required: false, unique: false, indexed: false }],
        } as never);
        await sql
          .raw(
            `ALTER TABLE "zvd_${name}" ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'draft', 'archived'))`,
          )
          .execute(db);
      }
      await sql`UPDATE zvd_collections SET fields = '[]'::jsonb WHERE name = ${EMPTY}`.execute(db);
      // ADOPTED's own status, as an install upgrading into 085 has it: unregistered.
      await sql`
        UPDATE zvd_collections SET fields = '[{"name":"title","type":"text"}]'::jsonb
         WHERE name = ${ADOPTED}
      `.execute(db);

      const url = new URL(
        '../../db/migrations/sql/085_collection_owned_status.sql',
        import.meta.url,
      );
      const { up } = parseMigrationFile(await Bun.file(url).text()) as { up: string };
      for (let i = 0; i < 2; i++) {
        await db.transaction().execute(async (trx) => {
          for (const stmt of splitSqlStatements(up)) await sql.raw(stmt).execute(trx);
        });
      }

      const old = (await fields(OLD)).filter((f) => f.name === 'status');
      expect(old).toHaveLength(1);
      expect(old[0]?.type).toBe('enum');
      expect(old[0]?.options?.values).toEqual(['active', 'draft', 'archived']);
      const adopted = (await fields(ADOPTED)).filter((f) => f.name === 'status');
      expect(adopted.map((f) => f.type)).toEqual(['text']);
      // Left to `syncFieldsFromDB`, which a recorded field would stop.
      expect(await fields(EMPTY)).toEqual([]);
    } finally {
      await dropTestCollection(db, OLD).catch(() => {});
      await dropTestCollection(db, EMPTY).catch(() => {});
    }
  });
});
