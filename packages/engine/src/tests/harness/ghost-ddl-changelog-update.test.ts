/**
 * Phase C — GhostDDL applyChangelog replays UPDATE mutations during batchCopy.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager, GhostDDL } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hgupd_${Date.now()}`;

d('ghost DDL changelog update (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let recordId = '';
  const tableName = `zvd_${COLLECTION}`;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'title', type: 'text', required: true, unique: false, indexed: false },
        { name: 'note', type: 'text', required: false, unique: false, indexed: false },
      ],
    } as never);
    const seed = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'update-me', note: 'before' }),
    });
    expect([200, 201]).toContain(seed.status);
    const body = (await seed.json()) as { id?: string };
    recordId = body.id ?? '';
    expect(recordId).toBeTruthy();
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

  it('applyChangelog replays PATCH updates captured during batchCopy', async () => {
    const migration = await GhostDDL.createGhost(db, tableName, [
      `ADD COLUMN extra TEXT NOT NULL DEFAULT ''`,
    ]);

    const patch = await app.request(`/api/data/${COLLECTION}/${recordId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ note: 'after-live-update' }),
    });
    expect([200, 204]).toContain(patch.status);

    await GhostDDL.batchCopy(db, migration);
    const applied = await GhostDDL.applyChangelog(db, migration);
    expect(applied).toBeGreaterThanOrEqual(1);
    await GhostDDL.atomicSwap(db, migration);

    const rows = await sql<{ note: string; extra: string }>`
      SELECT note, extra FROM ${sql.id(tableName)} WHERE id = ${recordId}
    `.execute(db);
    expect(rows.rows[0]?.note).toBe('after-live-update');
    expect(rows.rows[0]?.extra).toBe('');
  });
});
