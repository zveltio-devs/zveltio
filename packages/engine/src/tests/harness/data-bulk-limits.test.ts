/**
 * Phase C — bulk handler request limits (handlers/bulk.ts >500 guards).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hblim_${Date.now()}`;

const fakeUuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

d('data bulk limits (in-process)', () => {
  let app: Hono;
  let db: Database;
  let cookie = '';

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    await DDLManager.createCollection(db, {
      name: COLLECTION,
      fields: [{ name: 'label', type: 'text', required: true, unique: false, indexed: false }],
    } as never);
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

  const bulk = (method: string, body: unknown) =>
    app.request(`/api/data/${COLLECTION}/bulk`, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  it('rejects bulk create with more than 500 records', async () => {
    const records = Array.from({ length: 501 }, (_, i) => ({ label: `r-${i}` }));
    const res = await bulk('POST', { records });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail?: string; error?: string };
    expect((body.detail ?? body.error ?? '').toLowerCase()).toContain('500');
  });

  it('rejects bulk update with more than 500 records', async () => {
    const records = Array.from({ length: 501 }, (_, i) => ({
      id: fakeUuid(i + 1),
      label: `u-${i}`,
    }));
    const res = await bulk('PATCH', { records });
    expect(res.status).toBe(400);
  });

  it('rejects bulk delete with more than 500 ids', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => fakeUuid(i + 1));
    const res = await bulk('DELETE', { ids });
    expect(res.status).toBe(400);
  });
});
