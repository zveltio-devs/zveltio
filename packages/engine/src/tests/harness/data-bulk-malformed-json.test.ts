/**
 * Phase C — bulk handlers reject malformed JSON bodies (handlers/bulk.ts json catch).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { DDLManager } from '../../lib/data/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const COLLECTION = `hbjson_${Date.now()}`;

d('data bulk malformed JSON (in-process)', () => {
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

  const bulkRaw = (method: string, body: string) =>
    app.request(`/api/data/${COLLECTION}/bulk`, {
      method,
      headers: { 'Content-Type': 'application/json', cookie },
      body,
    });

  it('returns 400 when bulk POST body is not valid JSON', async () => {
    const res = await bulkRaw('POST', '{ not json');
    expect(res.status).toBe(400);
    const text = (await res.json()) as { detail?: string; error?: string };
    expect((text.detail ?? text.error ?? '').toLowerCase()).toMatch(/records|item|body/);
  });

  it('returns 400 when bulk PATCH body is not valid JSON', async () => {
    const res = await bulkRaw('PATCH', '{');
    expect(res.status).toBe(400);
  });

  it('returns 400 when bulk DELETE body is not valid JSON', async () => {
    const res = await bulkRaw('DELETE', 'not-json-at-all');
    expect(res.status).toBe(400);
    const text = (await res.json()) as { detail?: string; error?: string };
    expect((text.detail ?? text.error ?? '').toLowerCase()).toMatch(/ids|body/);
  });
});
