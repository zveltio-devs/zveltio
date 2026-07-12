/**
 * Phase C — dropCollection FK guard + force=true (ddl-manager.ts + routes/collections.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const PARENT = `hdrop_p_${Date.now()}`;
const CHILD = `hdrop_c_${Date.now()}`;

d('collections drop FK guard (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

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

    await DDLManager.createCollection(db, { name: PARENT, fields: [textField] });
    await DDLManager.createCollection(db, {
      name: CHILD,
      fields: [
        textField,
        {
          name: 'parent',
          type: 'm2o',
          required: false,
          unique: false,
          indexed: false,
          options: { related_collection: PARENT, on_delete: 'RESTRICT' },
        },
      ],
    } as never);
  });

  afterAll(async () => {
    if (!db) return;
    for (const name of [CHILD, PARENT]) {
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

  it('rejects DELETE without force when FK dependents exist', async () => {
    const res = await app.request(`/api/collections/${PARENT}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/foreign key|Cannot drop collection/i);
    expect(await DDLManager.tableExists(db, PARENT)).toBe(true);
  });

  it('DELETE ?force=true drops a referenced collection', async () => {
    const res = await app.request(`/api/collections/${PARENT}?force=true`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(await DDLManager.tableExists(db, PARENT)).toBe(false);
    expect(await DDLManager.getCollection(db, PARENT)).toBeNull();
  });
});
