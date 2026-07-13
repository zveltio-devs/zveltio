/**
 * Phase C — list handler applies queryAlterRegistry alters (handlers/list.ts applyAlters).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { queryAlterRegistry } from '../../lib/data/query-alter.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hqalt_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const ALTER_OWNER = 'harness-query-alter';

d('data list query-alter registry (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'label', type: 'text', required: true, unique: false, indexed: false },
        { name: 'score', type: 'number', required: false, unique: false, indexed: false },
      ],
    } as never);

    queryAlterRegistry.registerAs(ALTER_OWNER, TABLE, (qb, _user) =>
      qb.where('label', '=', 'keep-me'),
    );

    for (const label of ['keep-me', 'drop-me', 'keep-me']) {
      const res = await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ label, score: 1 }),
      });
      expect(res.status).toBe(201);
    }
  });

  afterAll(async () => {
    queryAlterRegistry.unregisterAll(ALTER_OWNER);
    if (!db) return;
    await sql
      .raw(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`)
      .execute(db)
      .catch(() => {});
    await db
      .deleteFrom('zvd_collections')
      .where('name', '=', COLLECTION)
      .execute()
      .catch(() => {});
  });

  it('filters list rows through registered query alters', async () => {
    const res = await app.request(`/api/data/${COLLECTION}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: Array<{ label: string }> };
    expect(body.records).toHaveLength(2);
    expect(body.records.every((r) => r.label === 'keep-me')).toBe(true);
  });
});
