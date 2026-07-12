/**
 * Phase C — foreign key violation via data write (write-pipeline mapPgError 23503).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const AUTHORS = `hfkauth_${Date.now()}`;
const BOOKS = `hfkbook_${Date.now()}`;

d('data foreign key violation (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: AUTHORS,
      fields: [{ name: 'name', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    await DDLManager.createCollection(db, {
      name: BOOKS,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        {
          name: 'author',
          type: 'reference',
          required: false,
          unique: false,
          indexed: false,
          options: { related_collection: AUTHORS, on_delete: 'SET NULL' },
        },
      ],
    } as never);
  });

  afterAll(async () => {
    if (!db) return;
    for (const name of [BOOKS, AUTHORS]) {
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
      .where('source_collection', '=', BOOKS)
      .execute()
      .catch(() => {});
  });

  it('POST / rejects a reference to a non-existent parent id', async () => {
    const res = await app.request(`/api/data/${BOOKS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        title: 'Orphan Book',
        author: '00000000-0000-0000-0000-000000000099',
      }),
    });
    expect([400, 422, 409]).toContain(res.status);
    const body = (await res.json()) as { error?: string; code?: string };
    if (body.error) {
      expect(['foreign_key_violation', 'validation_error', 'invalid_value']).toContain(body.error);
    }
  });
});
