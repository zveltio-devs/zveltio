/**
 * Phase C — POST create collection with inline m2m field (ddl-manager junction).
 *
 * Provisions a tag table, then POST-creates an article collection with an m2m
 * relation field so createJunctionTable + registerRelation run via the queue.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const TAGS = `hm2mt_${Date.now()}`;
const ARTICLES = `hm2ma_${Date.now()}`;

d('collections m2m inline create (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: TAGS,
      fields: [{ name: 'name', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
  });

  afterAll(async () => {
    if (!db) return;
    const junction = `zvd_jnc_${ARTICLES}_${TAGS}`;
    await sql
      .raw(`DROP TABLE IF EXISTS "${junction}" CASCADE`)
      .execute(db)
      .catch(() => {});
    for (const name of [ARTICLES, TAGS]) {
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
      .where('source_collection', '=', ARTICLES)
      .execute()
      .catch(() => {});
  });

  it('POST / creates a collection with an m2m junction to an existing target', async () => {
    const res = await app.request('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: ARTICLES,
        fields: [
          { name: 'title', type: 'text', required: true, unique: false, indexed: false },
          {
            name: 'tags',
            type: 'm2m',
            required: false,
            unique: false,
            indexed: false,
            options: { related_collection: TAGS },
          },
        ],
      }),
    });
    expect(res.status).toBe(202);
    expect(await DDLManager.tableExists(db, ARTICLES)).toBe(true);

    const rel = await db
      .selectFrom('zvd_relations')
      .selectAll()
      .where('source_collection', '=', ARTICLES)
      .where('source_field', '=', 'tags')
      .executeTakeFirst();
    expect(rel?.target_collection).toBe(TAGS);
    expect(rel?.junction_table).toBe(`zvd_jnc_${ARTICLES}_${TAGS}`);

    const junctionExists = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT FROM pg_tables
        WHERE schemaname = 'public' AND tablename = ${`zvd_jnc_${ARTICLES}_${TAGS}`}
      ) AS exists
    `.execute(db);
    expect(junctionExists.rows[0]?.exists).toBe(true);
  });
});
