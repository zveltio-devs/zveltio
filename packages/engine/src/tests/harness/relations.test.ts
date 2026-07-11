/**
 * Phase C — /api/relations m2o lifecycle (routes/relations.ts + ddl-manager.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SRC = `hrel_src_${Date.now()}`;
const TGT = `hrel_tgt_${Date.now()}`;

d('relations routes (in-process)', () => {
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
    await DDLManager.createCollection(db, { name: SRC, fields: [textField] });
    await DDLManager.createCollection(db, { name: TGT, fields: [textField] });
  });

  afterAll(async () => {
    if (!db) return;
    for (const name of [SRC, TGT]) {
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
      .where('source_collection', '=', SRC)
      .execute()
      .catch(() => {});
  });

  it('POST /api/relations creates an m2o FK + metadata', async () => {
    const res = await app.request('/api/relations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `${SRC}_customer`,
        type: 'm2o',
        source_collection: SRC,
        source_field: 'customer_id',
        target_collection: TGT,
        on_delete: 'SET NULL',
        on_update: 'CASCADE',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { relation?: { id: string } };
    relationId = body.relation!.id;
    expect(relationId).toBeDefined();

    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${`zvd_${SRC}`} AND column_name = 'customer_id'
    `.execute(db);
    expect(cols.rows.length).toBe(1);
  });

  it('GET /api/relations lists the new relation', async () => {
    const res = await app.request(`/api/relations?collection=${SRC}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { relations: Array<{ id: string }> };
    expect(body.relations.some((r) => r.id === relationId)).toBe(true);
  });

  it('DELETE /api/relations/:id removes FK column and metadata', async () => {
    const res = await app.request(`/api/relations/${relationId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const cols = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = ${`zvd_${SRC}`} AND column_name = 'customer_id'
    `.execute(db);
    expect(cols.rows.length).toBe(0);
  });
});
