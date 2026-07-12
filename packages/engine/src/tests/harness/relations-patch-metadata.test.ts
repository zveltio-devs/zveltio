/**
 * Phase C — PATCH /api/relations/:id updates relation metadata (routes/relations.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const SRC = `hpatch_src_${Date.now()}`;
const TGT = `hpatch_tgt_${Date.now()}`;

d('relations PATCH metadata (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let relationId = '';

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

    const create = await app.request('/api/relations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `${SRC}_link`,
        type: 'm2o',
        source_collection: SRC,
        source_field: 'link_id',
        target_collection: TGT,
        on_delete: 'SET NULL',
        on_update: 'NO ACTION',
      }),
    });
    expect(create.status).toBe(201);
    relationId = ((await create.json()) as { relation: { id: string } }).relation.id;
  });

  afterAll(async () => {
    if (!db) return;
    if (relationId) {
      try {
        await app.request(`/api/relations/${relationId}`, {
          method: 'DELETE',
          headers: { cookie },
        });
      } catch {
        /* best-effort */
      }
    }
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
  });

  it('PATCH /api/relations/:id updates on_delete and on_update in metadata', async () => {
    const res = await app.request(`/api/relations/${relationId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: `${SRC}_link_renamed`,
        on_delete: 'RESTRICT',
        on_update: 'CASCADE',
        metadata: { harness: true },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      relation: {
        name: string;
        on_delete: string;
        on_update: string;
        metadata: Record<string, unknown>;
      };
    };
    expect(body.relation.name).toBe(`${SRC}_link_renamed`);
    expect(body.relation.on_delete).toBe('RESTRICT');
    expect(body.relation.on_update).toBe('CASCADE');
    expect(body.relation.metadata.harness).toBe(true);
  });
});
