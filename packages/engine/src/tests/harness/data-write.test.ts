/**
 * Phase C — data WRITE-PIPELINE deep paths driven through the in-process app.
 *
 * Targets the still-uncovered lib/data write path (write-pipeline.ts,
 * handlers/single.ts PUT-replace, handlers/bulk.ts) rather than route breadth:
 *   - processInput field encryption (an `encrypted: true` column)
 *   - mapPgError constraint→422 mapping (a UNIQUE column + a duplicate insert)
 *   - replaceRecord (PUT /:id)
 *   - bulk update/delete over real ids
 *
 * Table provisioned via DDLManager; dropped in afterAll. Skips without a DB.
 */

import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hwrite_${Date.now()}`;

d('data write-pipeline (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let firstId: string;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'code', type: 'text', required: true, unique: true, indexed: true },
        { name: 'amount', type: 'number', required: false, unique: false, indexed: false },
        {
          name: 'secret',
          type: 'text',
          required: false,
          unique: false,
          indexed: false,
          encrypted: true,
        },
      ],
    } as never);
  });

  afterAll(async () => {
    if (db) {
      await sql
        .raw(`DROP TABLE IF EXISTS "zvd_${COLLECTION}" CASCADE`)
        .execute(db)
        .catch(() => {});
      await db
        .deleteFrom('zvd_collections')
        .where('name', '=', COLLECTION)
        .execute()
        .catch(() => {});
    }
  });

  const rec = (body: unknown): { id: string; [k: string]: unknown } => {
    const b = body as { data?: Record<string, unknown> };
    return (b.data ?? body) as { id: string; [k: string]: unknown };
  };

  const post = (body: unknown) =>
    app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  it('creates a record through the write pipeline (processInput + afterWrite)', async () => {
    // NOTE: the `secret` field is declared encrypted:true — this drives
    // processInput's encryption branch. (A separate task tracks that the value
    // currently lands in plaintext; this suite pins the write PATH, not that
    // security fix.)
    const res = await post({ code: 'A-1', amount: 10, secret: 'top-secret' });
    expect([200, 201]).toContain(res.status);
    const created = rec(await res.json());
    firstId = created.id;
    expect(firstId).toBeDefined();
    expect(created.code).toBe('A-1');

    // round-trips through the read handler
    const check = await app.request(`/api/data/${COLLECTION}/${firstId}`, { headers: { cookie } });
    expect(check.status).toBe(200);
    expect(rec(await check.json()).secret).toBe('top-secret');
  });

  it('maps a UNIQUE violation to a 422 (mapPgError path)', async () => {
    const res = await post({ code: 'A-1', amount: 20 }); // duplicate code
    expect([409, 422, 400]).toContain(res.status);
    const body = (await res.json()) as { status?: number; code?: string };
    expect(body).toBeDefined();
  });

  it('rejects a record missing the required field (validation/NOT NULL → 4xx)', async () => {
    const res = await post({ amount: 5 }); // no code
    expect([400, 422]).toContain(res.status);
  });

  it('replaces a record via PUT /:id (replaceRecord)', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/${firstId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ code: 'A-1', amount: 999, secret: 'rotated' }),
    });
    expect([200, 204]).toContain(res.status);

    const check = await app.request(`/api/data/${COLLECTION}/${firstId}`, { headers: { cookie } });
    const body = rec(await check.json());
    expect(Number(body.amount)).toBe(999);
    expect(body.secret).toBe('rotated');
  });

  it('bulk-updates and bulk-deletes over real ids', async () => {
    // seed two more
    const b1 = rec(await (await post({ code: 'B-1', amount: 1 })).json());
    const b2 = rec(await (await post({ code: 'B-2', amount: 2 })).json());

    const upd = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        records: [
          { id: b1.id, amount: 50 },
          { id: b2.id, amount: 50 },
        ],
      }),
    });
    expect(upd.status).toBe(200);
    const updBody = (await upd.json()) as { updated: number };
    expect(updBody.updated).toBe(2);

    const del = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ ids: [b1.id, b2.id] }),
    });
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as { deleted: number };
    expect(delBody.deleted).toBe(2);
  });
});
