/**
 * A row an extension's query alter hides is not reachable through the bulk
 * endpoints either.
 *
 * `handlers/single.ts` runs `queryAlterRegistry.applyAll` on the before-row
 * SELECT of GET, PUT, PATCH and DELETE, deliberately: "Apply query alters so a
 * row hidden by an extension filter cannot be deleted by ID". `handlers/bulk.ts`
 * mirrors the RLS conditions and the entity-access check with comments saying so
 * -- and does not mirror this third guard, which is the same SELECT.
 *
 * Extensions register alters for tenant isolation and soft-delete. Without this,
 * the batch endpoint is the way around both.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { queryAlterRegistry } from '../../lib/data/query-alter.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hqabulk_${Date.now()}`;
const TABLE = `zvd_${COLLECTION}`;
const ALTER_OWNER = 'harness-bulk-query-alter';

d('bulk writes honour query alters (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  /** Ids of rows the alter hides -- created BEFORE it is registered. */
  const hidden: string[] = [];
  const visible: string[] = [];

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'label', type: 'text', required: true, unique: false, indexed: false }],
    } as never);

    for (let i = 0; i < 100; i++) {
      const seen = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ${TABLE}
      `.execute(db);
      if (seen.rows[0]!.n > 0) break;
      await Bun.sleep(100);
    }

    // Created while nothing is hidden, so both rows exist.
    for (const label of ['keep-me', 'hide-me']) {
      const res = await app.request(`/api/data/${COLLECTION}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ label }),
      });
      expect(res.status).toBe(201);
      const row = (await res.json()) as { id: string };
      (label === 'keep-me' ? visible : hidden).push(row.id);
    }

    queryAlterRegistry.registerAs(ALTER_OWNER, TABLE, (qb, _user) =>
      qb.where('label', '=', 'keep-me'),
    );
  }, 60_000);

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

  it('the single-record path already hides the row', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${hidden[0]}`, { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it('bulk update cannot reach a row the alter hides', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ records: [{ id: hidden[0], label: 'rewritten' }] }),
    });
    const body = (await res.json()) as { updated: number };
    expect(body.updated).toBe(0);

    const still = await sql<{ label: string }>`
      SELECT label FROM ${sql.table(TABLE)} WHERE id = ${hidden[0]}::uuid
    `.execute(db);
    expect(still.rows[0]!.label).toBe('hide-me');
  });

  it('bulk delete cannot reach a row the alter hides', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ ids: [hidden[0]] }),
    });
    const body = (await res.json()) as { deleted: number };
    expect(body.deleted).toBe(0);

    const still = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.table(TABLE)} WHERE id = ${hidden[0]}::uuid
    `.execute(db);
    expect(still.rows[0]!.n).toBe(1);
  });

  it('a visible row still goes through', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ records: [{ id: visible[0], label: 'keep-me' }] }),
    });
    const body = (await res.json()) as { updated: number };
    expect(body.updated).toBe(1);
  });
});
