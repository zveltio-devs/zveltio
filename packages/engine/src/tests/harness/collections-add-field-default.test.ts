/**
 * Phase C — DDLManager.addField with defaultValue (ddl-manager.ts column DDL).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hdef_${Date.now()}`;

d('collections add field default (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  const tableName = `zvd_${COLLECTION}`;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'title', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
    await DDLManager.addField(db, COLLECTION, {
      name: 'phase',
      type: 'text',
      required: false,
      unique: false,
      indexed: false,
      defaultValue: 'draft',
    } as never);
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

  it('addField with defaultValue applies a column DEFAULT in Postgres', async () => {
    const def = await sql<{ column_default: string | null }>`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = ${tableName} AND column_name = 'phase'
    `.execute(db);
    expect(def.rows[0]?.column_default).toBeTruthy();
    expect(String(def.rows[0]?.column_default)).toContain('draft');

    const res = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ title: 'no-phase-sent' }),
    });
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { phase?: string };
    expect(body.phase).toBe('draft');
  });
});
