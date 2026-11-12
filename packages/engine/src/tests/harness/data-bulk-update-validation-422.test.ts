/**
 * Phase C — bulk PATCH validation error on one row → 422, nothing written (ADR 0044).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbval422_${Date.now()}`;

d('data bulk update validation 422 (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';
  let goodId = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [
        { name: 'label', type: 'text', required: true, unique: false, indexed: false },
        { name: 'contact', type: 'email', required: false, unique: false, indexed: false },
      ],
    } as never);

    const create = await app.request(`/api/data/${COLLECTION}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ label: 'good', contact: 'ok@example.com' }),
    });
    expect(create.status).toBe(201);
    goodId = ((await create.json()) as { id: string }).id;
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

  it('returns 422 when one row fails processInput validation, and writes neither', async () => {
    const res = await app.request(`/api/data/${COLLECTION}/bulk`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        records: [
          { id: goodId, contact: 'still-valid@example.com' },
          // An existing row, so validation is the only thing that can refuse it.
          // Aimed at an absent id, "Record not found" answered for it and the
          // test passed with the validation check removed.
          { id: goodId, contact: 'not-an-email' },
        ],
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: Array<{ index: number; errors: string[] }> };
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]!.index).toBe(1);
    expect(body.errors[0]!.errors.join(' ')).not.toContain('not found');

    const row = await sql<{ contact: string }>`
      SELECT contact FROM ${sql.id(`zvd_${COLLECTION}`)} WHERE id = ${goodId}
    `.execute(db);
    expect(row.rows[0]?.contact).toBe('ok@example.com');
  });
});
