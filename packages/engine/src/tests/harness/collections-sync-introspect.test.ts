/**
 * Phase C — sync-schema after manual DB column add (ddl-manager introspect + syncFieldsFromDB).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hsync_${Date.now()}`;

d('collections sync-schema introspect (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    await sql
      .raw(`ALTER TABLE "zvd_${COLLECTION}" ADD COLUMN IF NOT EXISTS "legacy_col" TEXT`)
      .execute(db);
    await db
      .updateTable('zvd_collections')
      .set({ fields: JSON.stringify([]) })
      .where('name', '=', COLLECTION)
      .execute();
  });

  afterAll(async () => {
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('POST /:name/sync-schema backfills metadata from information_schema', async () => {
    const res = await app.request(`/api/collections/${COLLECTION}/sync-schema`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { synced?: number };
    expect((body.synced ?? 0) > 0).toBe(true);

    const row = await DDLManager.getCollection(db, COLLECTION);
    const fields = typeof row?.fields === 'string' ? JSON.parse(row.fields) : (row?.fields ?? []);
    expect(fields.some((f: { name: string }) => f.name === 'legacy_col')).toBe(true);
  });
});
