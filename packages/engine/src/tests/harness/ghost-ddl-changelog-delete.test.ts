/**
 * Phase C — GhostDDL applyChangelog replays DELETE mutations during batchCopy.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, GhostDDL } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hgdel_${Date.now()}`;

d('ghost DDL changelog delete (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let deleteId = '';
  const tableName = `zvd_${COLLECTION}`;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);

    for (const title of ['keep-me', 'delete-me']) {
      const res = await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ title }),
      });
      expect([200, 201]).toContain(res.status);
      const body = (await res.json()) as { id?: string; title?: string };
      if (title === 'delete-me') deleteId = body.id ?? '';
    }
    expect(deleteId).toBeTruthy();
  });

  afterAll(async () => {
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS "${tableName}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('applyChangelog removes rows deleted during batchCopy', async () => {
    const migration = await GhostDDL.createGhost(db, tableName, [
      `ADD COLUMN marker TEXT NOT NULL DEFAULT 'ok'`,
    ]);

    const del = await app.request(`/api/data/${COLLECTION}/${deleteId}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    expect([200, 204]).toContain(del.status);

    await GhostDDL.batchCopy(db, migration);
    const applied = await GhostDDL.applyChangelog(db, migration);
    expect(applied).toBeGreaterThanOrEqual(1);
    await GhostDDL.atomicSwap(db, migration);

    const rows = await sql<{ title: string; marker: string }>`
      SELECT title, marker FROM ${sql.id(tableName)} ORDER BY title
    `.execute(db);
    expect(rows.rows.some((r) => r.title === 'keep-me' && r.marker === 'ok')).toBe(true);
    expect(rows.rows.some((r) => r.title === 'delete-me')).toBe(false);
  });
});
